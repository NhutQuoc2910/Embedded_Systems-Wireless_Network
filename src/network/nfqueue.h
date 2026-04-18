#ifndef _NFQUEUE_H
#define _NFQUEUE_H

#include <stdint.h>

int nfqueue_init(void);
void nfqueue_cleanup(void);
int nfqueue_set_packet_verdict(uint32_t packet_id, uint32_t verdict);

#endif /* _NFQUEUE_H */
