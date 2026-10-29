# Deploying Rev on Proxmox

Rev runs as two containers, the app (with ffmpeg) and Postgres, managed by Docker Compose. On Proxmox the simplest home for it is a Debian **LXC container** with Docker; a small VM works the same way.

## 1. Create the guest

**LXC (recommended).** It's lightweight, and media can live on any Proxmox storage via a mount point.

In the Proxmox UI, choose **Create CT**:

- Template: `debian-12-standard` (or 13)
- Unprivileged container: **yes**
- Features: **nesting=1, keyctl=1** (required for Docker; *Options → Features* after creation)
- CPU: 2 cores, more if you upload lots of `.mov`/`.mkv` files that need transcoding
- Memory: 2 GiB (4 GiB to build comfortably)
- Root disk: 16 GiB
- Network: a static IP or a DHCP reservation, so `PUBLIC_URL` stays valid

Or from the Proxmox shell:

```bash
# Template name: see `pveam available --section system` / `pveam list local`
pct create 120 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname rev --cores 2 --memory 4096 --swap 1024 \
  --rootfs local-lvm:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1
```

**Videos take space.** Give them their own volume so the root disk stays small and backups stay flexible:

```bash
# 200 GiB volume from the "tank" storage, mounted at /srv/rev-media inside the container
pct set 120 -mp0 tank:200,mp=/srv/rev-media
pct start 120
```

**VM alternative.** Install Debian 12 or Ubuntu 24.04 server, give it a second disk for media if you like, then continue below.

## 2. Install Rev

Inside the container (`pct enter 120`) or VM:

```bash
apt-get update && apt-get install -y git curl
git clone https://github.com/VibOtaku/rev.git /opt/rev
cd /opt/rev
PUBLIC_URL=http://192.168.1.50:8080 REV_MEDIA_DIR=/srv/rev-media ./deploy/install.sh
```

The installer:

1. installs Docker via `get.docker.com` if it is missing,
2. creates `.env` (random `POSTGRES_PASSWORD`, your `PUBLIC_URL` and `REV_MEDIA_DIR`),
3. runs `docker compose up -d --build`,
4. waits for `/api/health` and prints the **setup token**.

Open `PUBLIC_URL/setup`, enter the token, and create the first admin account. To see the token again later, run `docker compose logs rev | grep "setup token"`.

Then:

- **Admin → Invite someone** creates an invite link to send to each teammate. Rev doesn't send email.
- **Projects → New project**
- **My agents → New agent** gives you a token and setup commands for the agent's machine. Add the agent to a project from **Members**.

## 3. HTTPS (optional, recommended)

Choose one:

- **Existing reverse proxy** (Nginx Proxy Manager, Traefik, a Caddy LXC, …): point it at `http://<container-ip>:8080`. Set `PUBLIC_URL=https://rev.example.com` in `.env`, then `docker compose up -d`. Uploads can be large, so raise the proxy's body size limit (for nginx, `client_max_body_size 4g;`). Rev trusts `X-Forwarded-Proto` and `X-Forwarded-Host`.
- **Bundled Caddy**: set `REV_DOMAIN=rev.example.com` and `PUBLIC_URL=https://rev.example.com` in `.env`. You can also set `REV_BIND=127.0.0.1` so port 8080 is only reachable from Caddy. Then:

  ```bash
  docker compose --profile tls up -d
  ```

  Public DNS names get a Let's Encrypt certificate automatically (ports 80 and 443 must be reachable). For LAN-only names, uncomment `tls internal` in `deploy/Caddyfile` and install Caddy's root certificate on client machines.

With an `https://` `PUBLIC_URL`, session cookies are marked `Secure` automatically.

## 4. Backups

Choose one:

- **Proxmox-level:** schedule `vzdump` backups of the container (Datacenter → Backup). Snapshot mode is fine; Postgres recovers from a crash-consistent copy. Mount-point volumes are skipped unless `backup=1` is set on them: `pct set 120 -mp0 tank:vm-120-disk-1,mp=/srv/rev-media,backup=1`.
- **Application-level:** `deploy/backup.sh` writes `backups/<timestamp>/rev.dump` (from `pg_dump`) and `media.tar`. It keeps 14 days by default (`KEEP_DAYS`). To run it nightly:

  ```bash
  crontab -e
  15 3 * * * cd /opt/rev && ./deploy/backup.sh >> backups/backup.log 2>&1
  ```

  Restore with `./deploy/restore.sh backups/<timestamp>`.

## 5. Upgrades

```bash
cd /opt/rev
git pull
docker compose up -d --build
```

Database migrations run automatically when the container starts. Media and the database live in `REV_MEDIA_DIR` and `REV_DB_DIR` on the host, so rebuilding containers never touches them.

## Operations cheat sheet

| Task | Command |
| --- | --- |
| Status / health | `docker compose ps`, `curl localhost:8080/api/health` |
| Logs | `docker compose logs -f rev` |
| Restart | `docker compose restart rev` |
| Postgres shell | `docker compose exec db psql -U rev rev` |
| Disk usage | `du -sh data/* $REV_MEDIA_DIR` |
| Stop everything | `docker compose down` (data is kept) |

## Troubleshooting

- **Docker fails to start in the LXC.** Enable `nesting=1,keyctl=1` on the container and restart it.
- **Uploads fail at around 1 MB through a proxy.** Raise the proxy's request body limit.
- **Video says "Processing…" for a long time.** The file needs transcoding (`.mov`, `.mkv`, HEVC). Check `docker compose logs rev`; give the container more CPU for faster transcodes, or record MP4 (H.264) or WebM directly.
- **"Cross-origin request rejected".** The browser's origin doesn't match the host Rev sees. Set `PUBLIC_URL` to the exact URL people use and make sure the proxy forwards the `Host` header.
