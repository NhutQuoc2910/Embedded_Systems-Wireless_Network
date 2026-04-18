#include <arpa/inet.h>
#include <stdint.h>
#include <errno.h>
#include <libnetfilter_queue/libnetfilter_queue.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "defs.h"
#include "debug.h"
#include "netfilter_compat.h"
#include "nfqueue.h"
#include "packet_input.h"

static struct nfq_handle *nfq_handle_ctx = NULL;
static struct nfq_q_handle *nfq_queue = NULL;
static int nfq_socket = -1;

static void nfqueue_fd_callback(int fd);
static int nfqueue_packet_cb(struct nfq_q_handle *qh, struct nfgenmsg *nfmsg,
                             struct nfq_data *nfa, void *data);

int nfqueue_init(void)
{
    int ret;

    nfq_handle_ctx = nfq_open();

    if (!nfq_handle_ctx) {
        perror("nfq_open");
        return -1;
    }

    ret = nfq_unbind_pf(nfq_handle_ctx, AF_INET);

    if (ret < 0) {
        DEBUG(LOG_DEBUG, errno, "nfq_unbind_pf(AF_INET) failed");
    }

    if (nfq_bind_pf(nfq_handle_ctx, AF_INET) < 0) {
        perror("nfq_bind_pf");
        nfq_close(nfq_handle_ctx);
        nfq_handle_ctx = NULL;
        return -1;
    }

    nfq_queue = nfq_create_queue(nfq_handle_ctx, 0, &nfqueue_packet_cb, NULL);

    if (!nfq_queue) {
        perror("nfq_create_queue");
        nfq_close(nfq_handle_ctx);
        nfq_handle_ctx = NULL;
        return -1;
    }

    if (nfq_set_mode(nfq_queue, NFQNL_COPY_PACKET, 0xffff) < 0) {
        perror("nfq_set_mode");
        nfq_destroy_queue(nfq_queue);
        nfq_close(nfq_handle_ctx);
        nfq_queue = NULL;
        nfq_handle_ctx = NULL;
        return -1;
    }

    nfq_socket = nfq_fd(nfq_handle_ctx);

    if (attach_callback_func(nfq_socket, nfqueue_fd_callback) < 0) {
        fprintf(stderr, "Could not attach NFQUEUE callback\n");
        nfq_destroy_queue(nfq_queue);
        nfq_close(nfq_handle_ctx);
        nfq_queue = NULL;
        nfq_handle_ctx = NULL;
        nfq_socket = -1;
        return -1;
    }

    return 0;
}

void nfqueue_cleanup(void)
{
    if (nfq_queue) {
        nfq_destroy_queue(nfq_queue);
        nfq_queue = NULL;
    }

    if (nfq_handle_ctx) {
        nfq_close(nfq_handle_ctx);
        nfq_handle_ctx = NULL;
    }

    nfq_socket = -1;
}

int nfqueue_set_packet_verdict(uint32_t packet_id, uint32_t verdict)
{
    if (!nfq_queue)
        return -1;

    return nfq_set_verdict(nfq_queue, packet_id, verdict, 0, NULL);
}

static void nfqueue_fd_callback(int fd)
{
    char buf[65536];
    int len;

    len = recv(fd, buf, sizeof(buf), 0);

    if (len < 0) {
        DEBUG(LOG_WARNING, errno, __FUNCTION__, "recv() on NFQUEUE failed");
        return;
    }

    nfq_handle_packet(nfq_handle_ctx, buf, len);
}

static int nfqueue_packet_cb(struct nfq_q_handle *qh, struct nfgenmsg *nfmsg,
                             struct nfq_data *nfa, void *data)
{
    struct nfqnl_msg_packet_hdr *ph;
    unsigned char *payload = NULL;
    uint32_t packet_id;
    unsigned int indev = 0;
    unsigned int outdev = 0;
    int payload_len;
    int action;

    (void)qh;
    (void)nfmsg;
    (void)data;

    ph = nfq_get_msg_packet_hdr(nfa);

    if (!ph)
        return 0;

    packet_id = ntohl(ph->packet_id);
    indev = nfq_get_indev(nfa);
    outdev = nfq_get_outdev(nfa);
    payload_len = nfq_get_payload(nfa, &payload);

    action = packet_input_handle_packet(packet_id, payload, payload_len,
                                        ph->hook, indev, outdev);

    if (action == PACKET_INPUT_QUEUED)
        return 0;

    return nfqueue_set_packet_verdict(packet_id, action);
}
