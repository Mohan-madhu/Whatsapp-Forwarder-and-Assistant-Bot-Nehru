# WhatsApp Baileys Bot Commands And Features

## Terminal Commands

Run these commands from the project folder:

```powershell
cd D:\2026\Whatsapp-Forwarder\whatsapp-baileys-system
```

Install dependencies:

```powershell
npm install
```

Start the bot:

```powershell
npm start
```

Start the bot with owner/admin numbers:

```powershell
$env:OWNER_NUMBERS='918220348218'; npm start
```

Start the bot with multiple owner/admin numbers:

```powershell
$env:OWNER_NUMBERS='918220348218,919876543210'; npm start
```

Start the bot directly:

```powershell
node .\index.js
```

Start in dev mode:

```powershell
npm run dev
```

Reset broken WhatsApp login:

```powershell
npm run reset-auth
```

Switch to another WhatsApp account:

```powershell
npm run switch-account
```

Enable media download for one run:

```powershell
$env:MEDIA_DOWNLOAD_ENABLED='1'; npm start
```

Disable media download for one run:

```powershell
$env:MEDIA_DOWNLOAD_ENABLED='0'; npm start
```

## WhatsApp User Commands

Start or resume the bot menu:

```text
hi
hello
hey
```

Pause bot replies in that chat:

```text
STOP
```

Go back or choose menu options:

```text
0
1
2
3
4
5
6
7
8
9
10
```

## WhatsApp Forwarding Commands

Only configured owner/admin numbers can use these commands.

Tag a replied message for forwarding:

```text
WB-TAG
```

Forward the tagged message to numbers:

```text
WB-FORWARD
9876543210
9123456789
```

Check forwarding sessions:

```text
WB-STATUS
```

## Reply Limit Rules

The bot reply queue is strict:

- A reply waits at least `1` second before sending.
- Maximum `3` bot reply messages are sent per `1` second window.
- Maximum `2` different users receive bot replies per `1` second window.
- Extra replies stay in the queue and are sent later.

## Main Features

- Connects to WhatsApp using Baileys QR login.
- Saves WhatsApp auth in `auth_info_baileys/`.
- Supports switching WhatsApp accounts with `npm run switch-account`.
- Supports owner/admin numbers using `OWNER_NUMBERS`.
- Auto-replies to admission/helpdesk messages.
- Maintains each user's menu session in `data/sessions.json`.
- Supports `STOP` to pause replies per chat.
- Supports `hi`, `hello`, and `hey` to start/resume replies.
- Uses a strict reply queue to avoid fast spam-like sending.
- Logs bot activity to `bot.log`.
- Supports message tagging and forwarding to multiple numbers.
- Optionally downloads incoming media to `downloads/YYYY-MM-DD/`.

## Admission Menu Features

The bot can answer menu flows for:

- About NASC
- Courses and programs
- Admission process
- Fees and scholarships
- Campus facilities
- Placements and career
- Contact and location
- Brochure/download information
- Speak to counselor
- Speak to admission officer
- Frequently asked questions

## Important Files

Main bot:

```text
index.js
```

Forwarding module:

```text
forwarder.js
```

Media download module:

```text
media-downloader.js
```

Menu flow:

```text
data\flow.json
```

Course data:

```text
data\courses.json
```

User sessions:

```text
data\sessions.json
```

WhatsApp login files:

```text
auth_info_baileys\
```

Bot log:

```text
bot.log
```

## How To Access The Bot

1. Open PowerShell.
2. Go to the project folder.
3. Run `npm start`.
4. Scan the QR from WhatsApp.
5. From any WhatsApp chat, send `hi`, `hello`, or `hey`.
6. Use the number menu shown by the bot.

## How To Configure Owner/Admin Number

Use the phone number with country code and no `+` sign.

Example for one admin:

```powershell
$env:OWNER_NUMBERS='918220348218'; npm start
```

Example for multiple admins:

```powershell
$env:OWNER_NUMBERS='918220348218,919876543210'; npm start
```

Admin-only commands:

```text
WB-TAG
WB-FORWARD
WB-STATUS
```

Normal users can still use the admission menu, but they cannot use forwarding commands.

## How To Switch WhatsApp Account

1. Stop the bot with `Ctrl+C`.
2. Run:

```powershell
npm run switch-account
```

3. Start again:

```powershell
npm start
```

4. Scan the new QR with the new WhatsApp account.

To remove the old linked device from the old phone, open WhatsApp on that phone, go to **Linked devices**, select this bot/device, and tap **Log out**.
