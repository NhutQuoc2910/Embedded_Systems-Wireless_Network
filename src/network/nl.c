/*****************************************************************************
 *
 * Copyright (C) 2001 Uppsala University and Ericsson AB.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 *
 * Author: Erik Nordstrom, <erik.nordstrom@it.uu.se>
 *
 *****************************************************************************/
#include <arpa/inet.h>
#include <asm/types.h>
#include <errno.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

#include "debug.h"
#include "defs.h"
#include "packet_queue.h"

struct nlsock {
  int sock;
  int seq;
  struct sockaddr_nl local;
};

static struct sockaddr_nl peer = {AF_NETLINK, 0, 0, 0};
static struct nlsock rtnl;

static void nl_rt_callback(int sock);
static int nl_send(struct nlsock *nl, struct nlmsghdr *n);
static int prefix_length(int family, void *nm);
static int addattr(struct nlmsghdr *n, int type, void *data, int alen);
static int nl_kern_route(int action, int flags, int family, int index,
                         struct in_addr *dst, struct in_addr *gw,
                         struct in_addr *nm, int metric);

void nl_init(void) {
  int status;
  unsigned int addrlen;

  memset(&peer, 0, sizeof(struct sockaddr_nl));
  peer.nl_family = AF_NETLINK;
  peer.nl_pid = 0;
  peer.nl_groups = 0;

  memset(&rtnl, 0, sizeof(struct nlsock));
  rtnl.seq = 0;
  rtnl.local.nl_family = AF_NETLINK;
  rtnl.local.nl_groups = RTMGRP_NOTIFY | RTMGRP_IPV4_IFADDR | RTMGRP_IPV4_ROUTE;
  rtnl.local.nl_pid = getpid();

  rtnl.sock = socket(PF_NETLINK, SOCK_RAW, NETLINK_ROUTE);

  if (rtnl.sock < 0) {
    perror("Unable to create RT netlink socket");
    exit(-1);
  }

  addrlen = sizeof(rtnl.local);
  status = bind(rtnl.sock, (struct sockaddr *)&rtnl.local, addrlen);

  if (status == -1) {
    perror("Bind for RT netlink socket failed");
    exit(-1);
  }

  if (getsockname(rtnl.sock, (struct sockaddr *)&rtnl.local, &addrlen) < 0) {
    perror("Getsockname failed");
    exit(-1);
  }

  if (attach_callback_func(rtnl.sock, nl_rt_callback) < 0) {
    alog(LOG_ERR, 0, __FUNCTION__, "Could not attach callback.");
  }
}

void nl_cleanup(void) {
  if (rtnl.sock > 0)
    close(rtnl.sock);
}

static void nl_rt_callback(int sock) {
  int len, attrlen;
  socklen_t addrlen;
  struct nlmsghdr *nlm;
  struct nlmsgerr *nlmerr;
  struct ifaddrmsg *ifm;
  struct rtattr *rta;
  char buf[256];

  addrlen = sizeof(struct sockaddr_nl);
  len = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&peer, &addrlen);

  if (len <= 0)
    return;

  nlm = (struct nlmsghdr *)buf;

  switch (nlm->nlmsg_type) {
  case NLMSG_ERROR:
    nlmerr = NLMSG_DATA(nlm);
    if (nlmerr->error != 0) {
      DEBUG(LOG_DEBUG, 0, "NLMSG_ERROR, error=%d type=%d", nlmerr->error,
            nlmerr->msg.nlmsg_type);
    }
    break;
  case RTM_NEWADDR:
    ifm = NLMSG_DATA(nlm);
    rta = (struct rtattr *)((char *)ifm + sizeof(struct ifaddrmsg));
    attrlen =
        nlm->nlmsg_len - sizeof(struct nlmsghdr) - sizeof(struct ifaddrmsg);

    for (; RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
      if (rta->rta_type == IFA_ADDRESS) {
        struct in_addr ifaddr;

        memcpy(&ifaddr, RTA_DATA(rta), RTA_PAYLOAD(rta));
        DEBUG(LOG_DEBUG, 0, "Interface index %d changed address to %s",
              ifm->ifa_index, ip_to_str(ifaddr));
      }
    }
    break;
  case RTM_NEWROUTE:
    DEBUG(LOG_DEBUG, 0, "RTM_NEWROUTE");
    break;
  default:
    break;
  }
}

static int prefix_length(int family, void *nm) {
  int prefix = 0;

  if (family == AF_INET) {
    unsigned int tmp;

    memcpy(&tmp, nm, sizeof(unsigned int));

    while (tmp) {
      tmp = tmp << 1;
      prefix++;
    }

    return prefix;
  }

  DEBUG(LOG_DEBUG, 0, "Unsupported address family");
  return 0;
}

static int addattr(struct nlmsghdr *n, int type, void *data, int alen) {
  struct rtattr *attr;
  int len = RTA_LENGTH(alen);

  attr = (struct rtattr *)(((char *)n) + NLMSG_ALIGN(n->nlmsg_len));
  attr->rta_type = type;
  attr->rta_len = len;
  memcpy(RTA_DATA(attr), data, alen);
  n->nlmsg_len = NLMSG_ALIGN(n->nlmsg_len) + len;

  return 0;
}

static int nl_send(struct nlsock *nl, struct nlmsghdr *n) {
  int res;
  struct iovec iov = {(void *)n, n->nlmsg_len};
  struct msghdr msg = {(void *)&peer, sizeof(peer), &iov, 1, NULL, 0, 0};

  if (!nl)
    return -1;

  n->nlmsg_seq = ++nl->seq;
  n->nlmsg_pid = nl->local.nl_pid;
  n->nlmsg_flags |= NLM_F_ACK;

  res = sendmsg(nl->sock, &msg, 0);

  if (res < 0) {
    fprintf(stderr, "error: %s\n", strerror(errno));
    return -1;
  }

  return 0;
}

static int nl_kern_route(int action, int flags, int family, int index,
                         struct in_addr *dst, struct in_addr *gw,
                         struct in_addr *nm, int metric) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
    char attrbuf[1024];
  } req;

  if (!dst || !gw)
    return -1;

  memset(&req, 0, sizeof(req));

  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(struct rtmsg));
  req.nlh.nlmsg_type = action;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | flags;
  req.nlh.nlmsg_pid = 0;

  req.rtm.rtm_family = family;

  if (!nm)
    req.rtm.rtm_dst_len = sizeof(struct in_addr) * 8;
  else
    req.rtm.rtm_dst_len = prefix_length(AF_INET, nm);

  req.rtm.rtm_src_len = 0;
  req.rtm.rtm_tos = 0;
  req.rtm.rtm_table = RT_TABLE_MAIN;
  req.rtm.rtm_protocol = 100;
  req.rtm.rtm_scope = RT_SCOPE_LINK;
  req.rtm.rtm_type = RTN_UNICAST;
  req.rtm.rtm_flags = 0;

  addattr(&req.nlh, RTA_DST, dst, sizeof(struct in_addr));

  if (memcmp(dst, gw, sizeof(struct in_addr)) != 0) {
    req.rtm.rtm_scope = RT_SCOPE_UNIVERSE;
    addattr(&req.nlh, RTA_GATEWAY, gw, sizeof(struct in_addr));
  }

  if (index > 0)
    addattr(&req.nlh, RTA_OIF, &index, sizeof(index));

  addattr(&req.nlh, RTA_PRIORITY, &metric, sizeof(metric));

  return nl_send(&rtnl, &req.nlh);
}

int nl_send_add_route_msg(struct in_addr dest, struct in_addr next_hop,
                          int metric, u_int32_t lifetime, int rt_flags,
                          int ifindex) {
  (void)lifetime;
  (void)rt_flags;

  DEBUG(LOG_DEBUG, 0, "ADD/UPDATE: %s:%s ifindex=%d", ip_to_str(dest),
        ip_to_str(next_hop), ifindex);

  return nl_kern_route(RTM_NEWROUTE, NLM_F_CREATE | NLM_F_REPLACE, AF_INET,
                       ifindex, &dest, &next_hop, NULL, metric);
}

int nl_send_no_route_found_msg(struct in_addr dest) {
  DEBUG(LOG_DEBUG, 0, "No route found for %s", ip_to_str(dest));
  return packet_queue_set_verdict(dest, PQ_DROP);
}

int nl_send_del_route_msg(struct in_addr dest, struct in_addr next_hop,
                          int metric) {
  DEBUG(LOG_DEBUG, 0, "Send DEL_ROUTE to kernel: %s", ip_to_str(dest));

  return nl_kern_route(RTM_DELROUTE, 0, AF_INET, -1, &dest, &next_hop, NULL,
                       metric);
}

int nl_send_conf_msg(void) { return 0; }
