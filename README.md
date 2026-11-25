# Musicplayer

A self-hosted music player for your own files, laid out like Spotify. Every folder of music becomes a playlist, and you can make your own playlists on top of that. You listen in the browser, in the installable web app (which also works offline on a phone or laptop), or in a native Subsonic app.

Playlists can be imported from YouTube, YouTube Music, SoundCloud and Bandcamp through [yt-dlp](https://github.com/yt-dlp/yt-dlp), and from Spotify through [spotDL](https://github.com/spotDL/spotify-downloader), keeping the original audio. Single songs can be added by searching YouTube Music, from a link, or by uploading files, and Musicplayer warns you when you already have a song. YouTube noise such as "(Official Video)" or "- Topic" is hidden from titles, and removed songs sit in a trash folder for 30 days before they are deleted.

It has a password login with rate limiting and strict security headers, and in Docker it runs as a non-root user.

> Only import music you have the right to. Downloading from these services can break their terms of use and copyright law, depending on where you live.

> This project is vibecoded: it was written almost entirely by an AI coding assistant, with a person steering, testing and reviewing it. It has a test suite, but read the code before you rely on it, especially before exposing it to the internet.

## Contents

- [Quick start on your computer](#quick-start-on-your-computer)
- [Running it on a server (Docker)](#running-it-on-a-server-docker)
- [HTTPS](#https)
- [Phones: web app](#phones-web-app)
- [Desktop app (Windows)](#desktop-app-windows)
- [Native apps (Subsonic)](#native-apps-subsonic)
- [Using Musicplayer](#using-musicplayer)
- [Maintenance](#maintenance)
- [Configuration](#configuration)
- [Development and tests](#development-and-tests)

## Quick start on your computer

You need [Node.js](https://nodejs.org) 22 or newer, [Python](https://www.python.org) 3.10 or newer for the download tools, and [ffmpeg](https://ffmpeg.org) on your `PATH`.

```bash
npm install
npm run setup      # installs yt-dlp and spotDL into tools/venv (Windows paths; see below for macOS/Linux)
npm start          # http://localhost:4321
```

On Windows you can also double-click `start.cmd`. Put your music in `./music` (subfolders are fine). Playlists and settings are stored in `./data`.

On macOS and Linux, install the tools with:

```bash
python3 -m venv tools/venv && tools/venv/bin/pip install -U "yt-dlp[default]" spotdl
```

Without a password, Musicplayer only listens on `localhost` and has no login. That is fine on your own computer, but set `MUSICPLAYER_PASSWORD` before you make it reachable from other devices (see [Configuration](#configuration)).

## Running it on a server (Docker)

Any Linux machine with Docker and Docker Compose will do: a home server, a VM, a NAS or a VPS. The image contains Node.js, ffmpeg, yt-dlp and spotDL.

1. Copy this folder to the server, or clone the repository.
2. Create the settings file:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Set at least `MUSICPLAYER_PASSWORD`. For the built-in HTTPS, also fill in `DOMAIN`, `DNS_PROVIDER`, `DNS_TOKEN` and `ACME_EMAIL` (see [HTTPS](#https)).
3. Make the data folders writable for the container user (uid 1000):
   ```bash
   mkdir -p music data && sudo chown -R 1000:1000 music data
   ```
4. Start it:
   ```bash
   docker compose --profile home-https up -d --build    # with the built-in HTTPS (Caddy)
   # or
   docker compose up -d --build                         # Musicplayer only, on 127.0.0.1:4321, behind your own proxy
   ```

Your music and playlists are stored in `music/` and `data/` next to `docker-compose.yml`, and both survive restarts, updates and rebuilds. The server refuses to listen on a public address unless `MUSICPLAYER_PASSWORD` is set.

## HTTPS

Phones only allow the installable web app and offline downloads on secure sites, and most native apps expect HTTPS as well.

### Built-in: Caddy with a DNS challenge

This option suits home servers. The `home-https` profile runs [Caddy](https://caddyserver.com), which gets a trusted certificate through a DNS challenge: it proves that it owns the name by creating a temporary record through your DNS provider's API. Because nothing has to be reachable from the internet and no router ports are forwarded, it works for a server you only reach at home or through a VPN. The supported providers are dynv6 and DuckDNS, which are both free.

1. Give the server a fixed IP address on your network in your router's DHCP settings, for example `192.168.1.50`.
2. Create a name at your DNS provider, for example `music.example.dynv6.net`, and point it to the server's local IP (`192.168.1.50`). On dynv6, leave the IPv6 field empty.
3. Create an API token. On dynv6 it is under *Keys → HTTP Tokens*; DuckDNS shows it at the top of the page.
4. In `.env`:
   ```bash
   DOMAIN=music.example.dynv6.net
   DNS_PROVIDER=dynv6          # or duckdns
   DNS_TOKEN=your-token
   ACME_EMAIL=you@example.com  # for certificate expiry notices
   ```
5. Run `docker compose --profile home-https up -d --build` and watch `docker compose logs -f caddy-home` until it says "certificate obtained successfully", which takes about a minute.

Caddy tries Let's Encrypt first and falls back to ZeroSSL. Let's Encrypt limits how many certificates a domain can get per week, and on popular shared dynamic-DNS domains other users often use that up. Certificates renew automatically.

Make sure nothing updates this DNS record automatically, such as a dynamic-DNS feature in your router or an update script, because it would replace the local IP with your public one.

If the name doesn't resolve at home, your router may be blocking DNS answers that point to local addresses (often called DNS rebind protection). You can allow the domain in the router, or add a local DNS record that points the name at the server; most routers, including UniFi, pfSense, OPNsense and the Fritz!Box, support one of the two.

Away from home you need a way into your network, such as your router's VPN (WireGuard or OpenVPN) or Tailscale. The VPN should give your phone the router as its DNS server.

### Your own reverse proxy

Run `docker compose up -d --build` without the profile. Musicplayer then listens on `127.0.0.1:4321`, and you point your proxy (Caddy, nginx, Traefik or another) at it. The proxy has to pass the `Host` header and set `X-Forwarded-For` and `X-Forwarded-Proto`, and response buffering should be off for `/api/events`, which carries the live updates. Keep `MUSICPLAYER_TRUST_PROXY=1` (set in `docker-compose.yml`) only if the proxy is the only way in.

## Phones: web app

1. Open your Musicplayer address, for example `https://music.example.dynv6.net`, in Safari on an iPhone or Chrome on Android, and sign in.
2. Install it with Share → *Add to Home Screen* on an iPhone, or menu → *Install app* on Android, and open it from that icon from then on.
3. Tap the download arrow on the playlists you want offline. They then play without a connection.

Lock-screen and media controls work. On an iPhone the home-screen app keeps its own storage, separate from Safari, so download playlists inside the app. Your library shows how many songs are stored on the device.

## Desktop app (Windows)

`desktop/` holds a small [Tauri](https://tauri.app) app that opens your Musicplayer server in its own window, with its own taskbar icon and media keys. It doesn't run the server itself: it connects to the server you already run, for example in Docker.

**Install:** run `desktop/release/Musicplayer_1.0.0_x64-setup.exe`, or start `desktop/release/Musicplayer.exe` directly without installing. Windows 10 and 11 already include the WebView2 runtime it needs.

**First start:** enter your server address, for example `https://music.example.dynv6.net`, and sign in as usual. The app remembers the address and goes straight to it next time. If the server can't be reached, it asks for the address again. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> to change the server.

**Build it yourself.** You need [Node.js](https://nodejs.org), [Rust](https://rustup.rs) and the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the *Desktop development with C++* workload:

```powershell
winget install --id Rustlang.Rustup -e --source winget
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then:

```powershell
cd desktop
npm install
npm run build      # puts Musicplayer.exe and the installer in desktop/release
```

`npm run dev` starts the app without building an installer. `npm run icons` regenerates the app icons from `public/icons/icon-512.png`. The first build takes a few minutes; later builds are faster.

## Native apps (Subsonic)

Musicplayer speaks the [Subsonic API](http://www.subsonic.org/pages/api.jsp) and is compatible with OpenSubsonic, so native music apps can use it. They are more reliable than the web app for offline downloads and background playback, and they support CarPlay. On iOS you can use Amperfy (free and open source), play:Sub or substreamer; on Android, Symfonium or Tempo.

Sign in with:

- Server: your Musicplayer address, for example `https://music.example.dynv6.net`
- Username: anything, for example `music`
- Password: your `MUSICPLAYER_PASSWORD`

Apps see your playlists with the same names and order, albums and artists taken from the song tags, covers, and search, and they can stream and download songs. Playlists you create or change in an app also show up in the web app.

Importing, finding new songs, uploading and deleting are only possible in the web app. Removing a song from a playlist in an app only takes it out of that playlist, because files are never deleted through the API. Favourites, ratings and genres are not supported, so apps show them as empty.

## Using Musicplayer

Each folder with songs in `music/` becomes a playlist named after the folder. New files in that folder are added to it automatically. A song you remove from such a playlist stays removed, and a folder playlist you delete isn't recreated.

The + button on a playlist adds songs in four ways:

- Search for a song searches YouTube Music (songs only) by title or artist, and falls back to regular YouTube. Songs you already have are marked, and adding one reuses the existing file.
- Add from link adds one song from YouTube, Spotify (a track link), SoundCloud and similar sites.
- Upload files lets you pick files, or drag them onto the playlist on a computer.
- From your music folder adds songs that are already on the server.

The Import page takes whole playlists or albums. Each becomes a new playlist in `music/Imports/<name>/`, and single songs go to Singles.

Above the song list you can filter by title, artist or album, and sort by title, artist, album, recently added or length. The sort order is remembered per playlist, and playback follows the order you see.

Removing a song (⋯ → *Remove from this playlist*) also removes its file, unless the song is in another playlist too. The file goes to a trash folder and is deleted for good after 30 days.

Search results, links, uploads and imports are checked against your library, by YouTube video or by the same title from the same main artist, and you can reuse the copy you already have instead of downloading it again.

Titles are shown without "(Official Video)", "[Lyrics]", "4K", "Artist - " prefixes and "- Topic" or "VEVO" in channel names. The files themselves are not changed.

Spotify's audio is DRM-protected, so spotDL takes the track list and tags from Spotify and downloads each song from YouTube Music. Now and then a track is matched to the wrong version.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Seek 5 s |
| Ctrl + ← / → | Previous / next |
| Shift + ↑ / ↓ | Volume |
| M / S / R | Mute / shuffle / repeat |
| Ctrl + A | Select all songs in the playlist |

Select songs with click, Ctrl-click and Shift-click. Drag them onto a playlist in the sidebar to add them, or within a playlist to reorder them.

## Maintenance

```bash
docker compose --profile home-https ps              # status
docker compose --profile home-https logs -f         # logs
docker compose --profile home-https up -d --build   # update after changing code or .env
docker compose --profile home-https down            # stop (music and playlists stay)
```

To back up, copy `music/`, `data/` and `.env`.

yt-dlp and spotDL update themselves once a day, never during an import, and the Import page shows when they were last checked. Set `MUSICPLAYER_AUTO_UPDATE=0` to turn this off.

To change the password, edit `MUSICPLAYER_PASSWORD` in `.env` and restart. Every device is signed out.

Removed files stay in `data/trash/<date>/<original path>` for 30 days. To restore one, move it back into `music/` and add it to a playlist with + → *From your music folder*.

To add a lot of music at once, copy folders into `music/`, for example with `scp -r "My Album" user@server:musicplayer/music/`. Each folder becomes a playlist.

If Spotify imports fail with "rate limit" or 429, spotDL's shared Spotify key is overloaded. Create a free app at https://developer.spotify.com/dashboard and put its Client ID and Secret in `data/home/.spotdl/config.json` (`"client_id"`, `"client_secret"`).

After moving files around by hand, permission errors are fixed with `sudo chown -R 1000:1000 music data`, since the container runs as uid 1000.

## Configuration

Settings come from environment variables (`.env` when you use Docker) or from a `config.json` next to `package.json` (`musicDir`, `port`, `host`, `password`, `allowedHosts`, `trustProxy`).

| Variable | Default | Meaning |
|---|---|---|
| `MUSICPLAYER_PASSWORD` | (none) | Login password for the web app and Subsonic apps. Required when not on `localhost`. |
| `MUSIC_DIR` | `./music` (`/music` in Docker) | Your music; folders become playlists. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Playlists, covers, logins, trash, tool settings. |
| `PORT` | `4321` | HTTP port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address to listen on. |
| `MUSICPLAYER_TRUST_PROXY` | off | `1` = trust `X-Forwarded-For` from a reverse proxy (only if the proxy is the only way in). |
| `MUSICPLAYER_ALLOWED_HOSTS` | (none) | Extra host names allowed without a password. By default only `localhost` and IP addresses are, which protects against DNS rebinding. |
| `MUSICPLAYER_AUTO_UPDATE` | on | `0` = don't update yt-dlp and spotDL automatically. |
| `MUSICPLAYER_ALLOW_NO_PASSWORD` | off | `1` = allow a non-local `HOST` without a password (trusted private networks only). |
| `DOMAIN`, `DNS_PROVIDER`, `DNS_TOKEN`, `ACME_EMAIL` | | Built-in HTTPS (see [HTTPS](#https)). |

## Development and tests

```bash
npm test               # ~40 tests in a few seconds, no internet needed
npm run test:network   # also tests the YouTube Music search (needs internet)
npm run icons          # regenerate the app icons
```

The tests in `test/` start real throwaway servers with temporary folders and generated songs. They cover title cleanup, duplicate detection, sign-in and rate limiting, protection against DNS rebinding and CSRF, security headers, path traversal, playlists, uploads, the trash and the Subsonic API. Run `npm test` before every deploy.

| Path | What |
|---|---|
| `server/` | Node.js server (no framework): API, library scan, imports, Subsonic API, login |
| `public/` | Web app (plain JavaScript, no build step) and the service worker for offline use |
| `test/` | Test suite (`node --test`) |
| `caddy/` | Caddy build with DNS-provider plugins, and its config |
| `Dockerfile`, `docker-compose.yml` | Container setup |

The font is [Figtree](https://github.com/erikdkennedy/figtree), under the SIL Open Font License.
