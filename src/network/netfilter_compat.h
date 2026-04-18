#ifndef _NETFILTER_COMPAT_H
#define _NETFILTER_COMPAT_H

/*
 * Keep user-space code independent from linux/netfilter.h because that
 * header pulls in linux/in.h and clashes with glibc netinet headers.
 * These values are stable UAPI constants.
 */

#define NF_DROP 0
#define NF_ACCEPT 1

#define NF_INET_PRE_ROUTING 0
#define NF_INET_LOCAL_IN 1
#define NF_INET_FORWARD 2
#define NF_INET_LOCAL_OUT 3
#define NF_INET_POST_ROUTING 4

#endif /* _NETFILTER_COMPAT_H */
