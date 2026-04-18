#ifndef _PACKET_INPUT_H
#define _PACKET_INPUT_H

#include <stdint.h>

#ifndef NS_NO_DECLARATIONS

enum {
    PACKET_INPUT_QUEUED = -1
};

int packet_input_init(void);
void packet_input_cleanup(void);
int packet_input_handle_packet(uint32_t packet_id, unsigned char *payload,
                               int len, unsigned int hook,
                               unsigned int indev, unsigned int outdev);

#endif /* NS_NO_DECLARATIONS */

#endif /* _PACKET_INPUT_H */
