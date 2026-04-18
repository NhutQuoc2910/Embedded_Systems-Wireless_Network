#include <linux/netfilter.h>
#include <netinet/ip.h>
#include <netinet/udp.h>
#include <string.h>

#include "aodv_hello.h"
#include "aodv_neighbor.h"
#include "aodv_rerr.h"
#include "aodv_rreq.h"
#include "aodv_socket.h"
#include "aodv_timeout.h"
#include "defs.h"
#include "debug.h"
#include "nfqueue.h"
#include "packet_input.h"
#include "packet_queue.h"
#include "params.h"
#include "routing_table.h"

extern int wait_on_reboot;
extern struct timer worb_timer;

static int packet_is_aodv_control(const unsigned char *payload, int len);
static int packet_is_broadcast(struct in_addr dest_addr, unsigned int ifindex);
static int packet_is_direct_subnet(struct in_addr dest_addr,
                                   unsigned int ifindex);
static int packet_is_local_address(struct in_addr dest_addr);
static void send_rerr_for_unknown_dest(struct in_addr src_addr,
                                       struct in_addr dest_addr,
                                       rt_table_t *fwd_rt,
                                       rt_table_t *rev_rt,
                                       unsigned int ifindex);

int packet_input_init(void)
{
    return nfqueue_init();
}

void packet_input_cleanup(void)
{
    nfqueue_cleanup();
}

int packet_input_handle_packet(uint32_t packet_id, unsigned char *payload,
                               int len, unsigned int hook,
                               unsigned int indev, unsigned int outdev)
{
    struct iphdr *iph;
    struct in_addr dest_addr;
    struct in_addr src_addr;
    rt_table_t *fwd_rt = NULL;
    rt_table_t *rev_rt = NULL;
    unsigned int ifindex;
    u_int8_t rreq_flags = 0;

    if (!payload || len < (int)sizeof(struct iphdr))
        return NF_ACCEPT;

    iph = (struct iphdr *)payload;

    if (len < (int)(iph->ihl * 4))
        return NF_ACCEPT;

    dest_addr.s_addr = iph->daddr;
    src_addr.s_addr = iph->saddr;

    ifindex = (hook == NF_INET_FORWARD) ? indev : outdev;

    if (packet_is_local_address(dest_addr) ||
        packet_is_broadcast(dest_addr, ifindex) ||
        packet_is_direct_subnet(dest_addr, outdev) ||
        packet_is_aodv_control(payload, len)) {
        return NF_ACCEPT;
    }

    if (iph->protocol == IPPROTO_TCP)
        rreq_flags |= RREQ_GRATUITOUS;

    rev_rt = rt_table_find(src_addr);
    fwd_rt = rt_table_find(dest_addr);

    rt_table_update_route_timeouts(fwd_rt, rev_rt);

    if (!fwd_rt || fwd_rt->state == INVALID ||
        (fwd_rt->hcnt == 1 && (fwd_rt->flags & RT_UNIDIR))) {
        if (fwd_rt && (fwd_rt->flags & RT_REPAIR))
            goto route_discovery;

        if (hook == NF_INET_FORWARD) {
            send_rerr_for_unknown_dest(src_addr, dest_addr, fwd_rt, rev_rt,
                                       ifindex);
            return NF_DROP;
        }

route_discovery:
        packet_queue_add(packet_id, dest_addr);

        if (fwd_rt && (fwd_rt->flags & RT_REPAIR))
            rreq_local_repair(fwd_rt, src_addr, NULL);
        else
            rreq_route_discovery(dest_addr, rreq_flags, NULL);

        return PACKET_INPUT_QUEUED;
    }

    return NF_ACCEPT;
}

static int packet_is_aodv_control(const unsigned char *payload, int len)
{
    const struct iphdr *iph = (const struct iphdr *)payload;
    const struct udphdr *udph;
    int ip_header_len;

    if (iph->protocol != IPPROTO_UDP)
        return 0;

    ip_header_len = iph->ihl * 4;

    if (len < ip_header_len + (int)sizeof(struct udphdr))
        return 0;

    udph = (const struct udphdr *)(payload + ip_header_len);

    return ntohs(udph->source) == AODV_PORT || ntohs(udph->dest) == AODV_PORT;
}

static int packet_is_broadcast(struct in_addr dest_addr, unsigned int ifindex)
{
    if (dest_addr.s_addr == AODV_BROADCAST)
        return 1;

    if (ifindex > 0 && DEV_IFINDEX(ifindex).enabled &&
        dest_addr.s_addr == DEV_IFINDEX(ifindex).broadcast.s_addr) {
        return 1;
    }

    return 0;
}

static int packet_is_direct_subnet(struct in_addr dest_addr,
                                   unsigned int ifindex)
{
    struct in_addr mask;
    struct in_addr local;

    if (ifindex == 0 || !DEV_IFINDEX(ifindex).enabled)
        return 0;

    mask = DEV_IFINDEX(ifindex).netmask;
    local = DEV_IFINDEX(ifindex).ipaddr;

    return (dest_addr.s_addr & mask.s_addr) == (local.s_addr & mask.s_addr);
}

static int packet_is_local_address(struct in_addr dest_addr)
{
    int i;

    for (i = 0; i < this_host.nif; i++) {
        if (!DEV_NR(i).enabled)
            continue;

        if (DEV_NR(i).ipaddr.s_addr == dest_addr.s_addr)
            return 1;
    }

    return 0;
}

static void send_rerr_for_unknown_dest(struct in_addr src_addr,
                                       struct in_addr dest_addr,
                                       rt_table_t *fwd_rt,
                                       rt_table_t *rev_rt,
                                       unsigned int ifindex)
{
    RERR *rerr;
    struct in_addr rerr_dest;

    if (fwd_rt) {
        rerr = rerr_create(0, fwd_rt->dest_addr, fwd_rt->dest_seqno);
        rt_table_update_timeout(fwd_rt, DELETE_PERIOD);
    } else {
        rerr = rerr_create(0, dest_addr, 0);
    }

    if (rev_rt && rev_rt->state == VALID)
        rerr_dest = rev_rt->next_hop;
    else
        rerr_dest.s_addr = AODV_BROADCAST;

    aodv_socket_send((AODV_msg *)rerr, rerr_dest, RERR_CALC_SIZE(rerr), 1,
                     &DEV_IFINDEX(ifindex));

    if (wait_on_reboot) {
        timer_set_timeout(&worb_timer, DELETE_PERIOD);
    }
}
