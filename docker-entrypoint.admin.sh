#!/bin/sh
# Drop the admin container to an unprivileged user before starting Node.
#
# The image itself needs no privilege: userspace-networking tailscaled takes no
# capability, and both listeners are above 1024. The one thing that does need
# root is the Railway volume. It mounts over /data at runtime, which masks
# whatever ownership the image gave that path, so the state directory can only
# be prepared here: after the mount, before privileges are dropped.
#
# setpriv execs rather than forks, so Node still becomes PID 1 and still
# receives SIGTERM straight from Railway, which is what lets the supervisor
# stop tailscaled cleanly.
set -eu

STATE_DIR="${ADMIN_TS_STATE_DIR:-/data/tailscale}"
RUN_AS="node"

log() { echo "[entrypoint] $*"; }

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged: a local `docker run --user`, or RAILWAY_RUN_UID set
  # on the service. Nothing to prepare that we could prepare, and nothing to
  # drop.
  log "starting as uid $(id -u); volume preparation skipped"
  exec "$@"
fi

prepared=no
if mkdir -p "$STATE_DIR" 2>/dev/null && chown -R "$RUN_AS:$RUN_AS" "$STATE_DIR" 2>/dev/null; then
  parent=$(dirname "$STATE_DIR")
  # The volume root has to be traversable for the state directory to be
  # reachable. Never touch "/" itself.
  if [ "$parent" != "/" ]; then
    chmod a+rx "$parent" 2>/dev/null || true
  fi
  # Prove the drop will work before committing to it, by doing as the
  # unprivileged user exactly what tailscaled will do first.
  if setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --init-groups -- \
      sh -c "touch \"$STATE_DIR/.permcheck\" && rm -f \"$STATE_DIR/.permcheck\"" 2>/dev/null; then
    prepared=yes
  fi
fi

if [ "$prepared" = yes ]; then
  log "dropping to $RUN_AS; state directory $STATE_DIR is writable"
  exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --init-groups -- "$@"
fi

# Deliberate: this service is volume-backed, so Railway stops the old container
# before the new one starts and a refusal here is an outage rather than a stale
# image. Staying up as root and saying so loudly beats going dark. The boot
# audit event records the uid, so this shows up in the panel as well as here.
log "WARNING: could not hand $STATE_DIR to $RUN_AS; continuing as root."
log "WARNING: the container is NOT running unprivileged. Investigate before relying on it."
exec "$@"
