# Nova Studio ⚡

Browser ထဲမှာပဲ video လုပ်တဲ့ tools — **server မလို, build မလို**။ Pure HTML/CSS/JS။

## Tabs
- ✂️ **Nova Cut** — video ကို မိနစ်ပိုင်းနဲ့ အပိုင်းလိုက် ဖြတ် (stream copy, အရမ်းမြန်)
- 🎬 **Video Editor** — crop / flip / watermark / SRT burn-in / 480p compress / MP3 ထုတ်
- 🎙️ **Recap Nova** — video → အသံခွဲ → Groq Whisper transcribe → Gemini recap script → Edge TTS (browser) → video နဲ့ ပြန်တွဲ + SRT

## Render မှာ တင်နည်း (Static Site)
1. ဒီ folder ကို GitHub repo တစ်ခုမှာ တင် (root မှာပဲ ထား)
2. Render Dashboard → **New +** → **Static Site** → repo ရွေး
3. Settings:
   - **Build Command:** (ချန်ထား / empty)
   - **Publish Directory:** `.` (repo root)
4. Deploy — ပြီးရင် `https://nova-studio.onrender.com` လို URL ရမယ်

`render.yaml` လည်း ထည့်ပေးထားတယ် — Blueprint ("New → Blueprint") နဲ့ တင်လည်းရတယ်။

## ဘာလို့ coi-serviceworker.js ပါလဲ
ffmpeg.wasm ရဲ့ multi-thread core က `SharedArrayBuffer` လိုတယ်။ အဲ့တာ အလုပ်လုပ်ဖို့ site က
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
headers တွေ ပြန်ပေးရတယ်။ Static host တော်တော်များများမှာ header ပြင်လို့မရဘူး —
ဒါကြောင့် service worker က headers တွေကို browser ဘက်က ထိုးထည့်ပေးတာ။
Multi-thread load မအောင်မြင်ရင် app က single-thread core (`@ffmpeg/core-st`) ကို
auto-fallback လုပ်တယ် — SharedArrayBuffer မလိုဘူး။

## API Keys
- **Groq** (transcribe): https://console.groq.com → API Keys → `gsk_...`
- **Gemini** (recap script): https://aistudio.google.com → Get API Key → `AIza...`

Keys တွေက browser ရဲ့ localStorage (`nova_groq_key`, `nova_gemini_key`) ထဲမှာပဲ သိမ်းတယ်။
Code ထဲမှာ key hardcode လုံးဝမရှိဘူး။

## သိထားဖို့
- Video file တွေက ဘယ် server မှမတက်ဘူး — အားလုံး ဒီ browser ထဲမှာပဲ။
- ဖုန်း spec နိမ့်ရင် video ကြီးတွေ re-encode လုပ်တာ ကြာနိုင်တယ် (Nova Cut က copy ပဲမို့ မြန်တယ်)။
- Edge TTS က Microsoft server ကို WebSocket နဲ့ တိုက်ရိုက်ချိတ်တာ — internet လိုတယ်။
