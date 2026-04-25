# WhatsApp Baileys Bot (NASC Clone)

This folder is a Baileys-based version of your existing `whatsapp-web.js` bot.

## What is included

- Same menu flow using `data/flow.json`
- Same course flow using `data/courses.json`
- Session persistence in `data/sessions.json`
- Forwarding commands:
  - `WB-TAG` (reply to a message)
  - `WB-FORWARD` + number list
  - `WB-STATUS`
- Strict rate-limited send queue:
  - Replies wait at least 1 second before sending
  - Maximum 3 reply messages per second
  - Maximum 2 different users per second
- Owner/admin numbers with `OWNER_NUMBERS`
- Bot logging (`bot.log`)
- Full command/features reference in `COMMANDS_AND_FEATURES.md`

## Setup

1. Open terminal in this folder:
   - `cd d:\2026\Whatsapp-Forwarder\whatsapp-baileys-system`
2. Install packages:
   - `npm install`
3. Start bot:
   - `npm start`
4. Scan QR shown in terminal from your WhatsApp linked devices.

## Owner/Admin Number

Set the owner/admin number before starting the bot:

```powershell
$env:OWNER_NUMBERS='918220348218'; npm start
```

For multiple admins:

```powershell
$env:OWNER_NUMBERS='918220348218,919876543210'; npm start
```

Admin numbers can use `WB-TAG`, `WB-FORWARD`, and `WB-STATUS`. Normal users can still use the admission menu, but cannot use forwarding commands.

## Notes

- Auth/session files are stored in `auth_info_baileys/`.
- If login breaks, stop bot, run `npm run reset-auth`, and run `npm start` again.
- Existing `whatsapp-web.js` bot remains untouched in the parent folder.

## Switch WhatsApp Account

1. Stop the bot with `Ctrl+C`.
2. Run:
   - `npm run switch-account`
3. Start again:
   - `npm start`
4. Scan the new QR from the WhatsApp account you want to use.

This removes only the local Baileys login files. To remove the old linked device from the old phone too, open WhatsApp on that phone, go to **Linked devices**, select this bot/device, and tap **Log out**.

## Optional Media Download (Local Archive)

There is a separate module:
- `media-downloader.js`

Enable/disable options:
1. File switch:
   - Set `MEDIA_DOWNLOAD.ENABLED` to `1` (ON) or `0` (OFF).
2. Environment override (recommended):
   - PowerShell ON: `$env:MEDIA_DOWNLOAD_ENABLED='1'; node .\index.js`
   - PowerShell OFF: `$env:MEDIA_DOWNLOAD_ENABLED='0'; node .\index.js`

When enabled:
- Incoming media (document/video/image/audio/sticker) is saved to:
  - `downloads/YYYY-MM-DD/...`
- A log line is written:
  - `WA media saved type=... from=... path=...`

## Troubleshooting

- If you see `Connection closed. code=405`:
  1. Stop the bot.
  2. Run `npm run reset-auth`.
  3. Run `npm start` and scan the fresh QR.
- If you see `code=428`, `code=408`, or a WebSocket `1006` close:
  - Keep the bot running; it will retry automatically.
  - If it repeats for several minutes, stop the bot, run `npm run reset-auth`, then scan again.
- If `npm audit` shows critical issues:
  - The current alert is from Baileys transitive dependency (`@whiskeysockets/libsignal-node -> protobufjs@6.8.8`).
  - `npm audit fix` does not resolve it automatically because it is upstream/transitive.
