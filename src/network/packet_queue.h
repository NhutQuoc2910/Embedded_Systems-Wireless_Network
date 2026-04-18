#ifndef _PACKET_QUEUE_H
#define _PACKET_QUEUE_H

#include <stdint.h>

#include "defs.h"
#include "list.h"

#define MAX_QUEUE_LENGTH 512
#define MAX_QUEUE_TIME 10000
#define GARBAGE_COLLECT_TIME 1000

enum {
    PQ_DROP = 0,
    PQ_SEND = 1,
    PQ_ENC_SEND = 2
};

struct q_pkt {
    list_t l;
    struct in_addr dest_addr;
    struct timeval q_time;
    uint32_t packet_id;
};

struct packet_queue {
    list_t head;
    unsigned int len;
    struct timer garbage_collect_timer;
};

extern struct packet_queue PQ;

void packet_queue_init(void);
void packet_queue_destroy(void);
void packet_queue_add(uint32_t packet_id, struct in_addr dest_addr);
int packet_queue_set_verdict(struct in_addr dest_addr, int verdict);
int packet_queue_garbage_collect(void);
void packet_queue_timeout(void *arg);

#endif /* _PACKET_QUEUE_H */
