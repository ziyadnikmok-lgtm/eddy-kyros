#!/usr/bin/env node
const { execSync } = require('node:child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const image = arg('--image');
const caption = arg('--caption') || '';
const confirm = process.argv.includes('--confirm');
const postNow = process.argv.includes('--post-now');

if (!image) {
  console.error('Missing --image "/absolute/path"');
  process.exit(1);
}
if (!confirm && !postNow) {
  console.error('Use either --confirm or --post-now');
  process.exit(1);
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const cap = esc(caption);
const img = esc(image);

const appleScript = `
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to "https://x.com/compose/post"
end tell

delay 5

tell application "Google Chrome"
  execute active tab of front window javascript "(() => { const t=document.querySelector('[data-testid=\\\"tweetTextarea_0\\\"]'); if(!t) return 'no-text'; t.focus(); return 'text-focused'; })();"
end tell

delay 0.4

tell application "System Events"
  keystroke "${cap}"
end tell

delay 0.4

tell application "Google Chrome"
  execute active tab of front window javascript "(() => { const i=document.querySelector('input[type=\\\"file\\\"]'); if(!i) return 'no-file-input'; i.click(); return 'file-dialog-open'; })();"
end tell

delay 1

tell application "System Events"
  keystroke "G" using {command down, shift down}
  delay 0.4
  keystroke "${img}"
  delay 0.2
  key code 36
  delay 0.5
  key code 36
end tell

delay 6

tell application "Google Chrome"
  set chk to execute active tab of front window javascript "(() => { const media = document.querySelectorAll('[data-testid=\\\"tweetPhoto\\\"], [data-testid=\\\"mediaPreview\\\"], img[src*=\\\"pbs.twimg.com/media\\\"], video'); const btn=document.querySelector('[data-testid=\\\"tweetButton\\\"], [data-testid=\\\"tweetButtonInline\\\"]'); return JSON.stringify({mediaCount: media.length, btn: !!btn, disabled: btn?btn.disabled:null}); })();"
end tell

return chk
`;

let chkRaw;
try {
  chkRaw = execSync(`osascript <<'APPLESCRIPT'\n${appleScript}\nAPPLESCRIPT`, { encoding: 'utf8' }).trim();
} catch (e) {
  console.error(String(e.stderr || e.message || e));
  process.exit(1);
}

let chk;
try { chk = JSON.parse(chkRaw); } catch {
  console.error('Failed to parse check:', chkRaw);
  process.exit(1);
}

if (!chk.btn || chk.disabled || chk.mediaCount < 1) {
  console.error('Not ready:', chk);
  process.exit(2);
}

if (confirm) {
  console.log('READY_TO_POST', chk);
  process.exit(0);
}

const clickScript = `
tell application "Google Chrome"
  execute active tab of front window javascript "(() => { const b=document.querySelector('[data-testid=\\\"tweetButton\\\"], [data-testid=\\\"tweetButtonInline\\\"]'); if(!b) return 'no-btn'; if(b.disabled) return 'disabled'; b.click(); return 'posted-click'; })();"
end tell
`;

const result = execSync(`osascript <<'APPLESCRIPT'\n${clickScript}\nAPPLESCRIPT`, { encoding: 'utf8' }).trim();
console.log(result);
