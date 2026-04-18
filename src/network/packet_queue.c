#include <linux/netfilter.h>
#include <stdio.h>
#include <stdlib.h>

#include "debug.h"
#include "nfqueue.h"
#include "packet_queue.h"
#include "params.h"
#include "routing_table.h"

struct packet_queue PQ;

void packet_queue_init(void)
{
    INIT_LIST_HEAD(&PQ.head);
    PQ.len = 0;

    timer_init(&PQ.garbage_collect_timer, packet_queue_timeout, &PQ);
    timer_set_timeout(&PQ.garbage_collect_timer, GARBAGE_COLLECT_TIME);
}

void packet_queue_destroy(void)
{
    list_t *pos, *tmp;

    list_foreach_safe(pos, tmp, &PQ.head) {
        struct q_pkt *qp = (struct q_pkt *)pos;

        list_detach(pos);
        nfqueue_set_packet_verdict(qp->packet_id, NF_DROP);
        free(qp);
    }

    PQ.len = 0;
}

void packet_queue_add(uint32_t packet_id, struct in_addr dest_addr)
{
    struct q_pkt *qp;

    if (PQ.len >= MAX_QUEUE_LENGTH && !list_empty(&PQ.head)) {
        qp = (struct q_pkt *)PQ.head.next;
        list_detach(PQ.head.next);
        nfqueue_set_packet_verdict(qp->packet_id, NF_DROP);
        free(qp);
        PQ.len--;
    }

    qp = (struct q_pkt *)malloc(sizeof(struct q_pkt));

    if (!qp) {
        fprintf(stderr, "Malloc failed!\n");
        exit(-1);
    }

    INIT_LIST_ELM(&qp->l);
    qp->packet_id = packet_id;
    qp->dest_addr = dest_addr;
    gettimeofday(&qp->q_time, NULL);

    list_add_tail(&PQ.head, &qp->l);
    PQ.len++;

    DEBUG(LOG_INFO, 0, "Buffered packet id=%u to %s qlen=%u",
          packet_id, ip_to_str(dest_addr), PQ.len);
}

int packet_queue_set_verdict(struct in_addr dest_addr, int verdict)
{
    int count = 0;
    rt_table_t *rt = NULL;
    rt_table_t *next_hop_rt = NULL;
    rt_table_t *inet_rt = NULL;
    list_t *pos, *tmp;
    uint32_t nf_verdict;

    if (verdict == PQ_DROP) {
        nf_verdict = NF_DROP;
    } else {
        nf_verdict = NF_ACCEPT;

        if (verdict == PQ_ENC_SEND)
            inet_rt = rt_table_find(dest_addr);

        rt = rt_table_find(dest_addr);

        if (!rt && inet_rt)
            rt = rt_table_find(inet_rt->next_hop);

        if (!rt)
            return -1;
    }

    list_foreach_safe(pos, tmp, &PQ.head) {
        struct q_pkt *qp = (struct q_pkt *)pos;

        if (qp->dest_addr.s_addr != dest_addr.s_addr)
            continue;

        list_detach(pos);
        nfqueue_set_packet_verdict(qp->packet_id, nf_verdict);
        free(qp);
        PQ.len--;
        count++;
    }

    if (rt && rt->state == VALID && verdict != PQ_DROP) {
        rt_table_update_timeout(rt, ACTIVE_ROUTE_TIMEOUT);

        next_hop_rt = rt_table_find(rt->next_hop);

        if (next_hop_rt && next_hop_rt->state == VALID &&
            next_hop_rt->dest_addr.s_addr != rt->dest_addr.s_addr) {
            rt_table_update_timeout(next_hop_rt, ACTIVE_ROUTE_TIMEOUT);
        }
    }

    if (count > 0) {
        if (verdict == PQ_DROP) {
            DEBUG(LOG_INFO, 0, "Dropped %d queued packet(s) for %s qlen=%u",
                  count, ip_to_str(dest_addr), PQ.len);
        } else {
            DEBUG(LOG_INFO, 0, "Accepted %d queued packet(s) for %s qlen=%u",
                  count, ip_to_str(dest_addr), PQ.len);
        }
    }

    return count;
}

int packet_queue_garbage_collect(void)
{
    int count = 0;
    list_t *pos, *tmp;
    struct timeval now;

    gettimeofday(&now, NULL);

    list_foreach_safe(pos, tmp, &PQ.head) {
        struct q_pkt *qp = (struct q_pkt *)pos;

        if (timeval_diff(&now, &qp->q_time) <= MAX_QUEUE_TIME)
            continue;

        list_detach(pos);
        nfqueue_set_packet_verdict(qp->packet_id, NF_DROP);
        free(qp);
        PQ.len--;
        count++;
    }

    if (count > 0) {
        DEBUG(LOG_DEBUG, 0, "Removed %d expired queued packet(s)", count);
    }

    return count;
}

void packet_queue_timeout(void *arg)
{
    (void)arg;

    packet_queue_garbage_collect();
    timer_set_timeout(&PQ.garbage_collect_timer, GARBAGE_COLLECT_TIME);
}
