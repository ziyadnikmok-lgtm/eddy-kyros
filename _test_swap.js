const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const sharp = require('sharp');
const crypto = require('crypto');

const udp = process.env.APPDATA + '/ai-content-studio';
const envContent = fs.readFileSync(path.join(udp, '.env'), 'utf8');
const encSecret = envContent.match(/ENCRYPTION_SECRET=(.+)/)?.[1]?.trim();
const store = JSON.parse(fs.readFileSync(path.join(udp, 'data', 'keys.enc'), 'utf8'));
function decrypt(ep, s) {
  const [sh, ih, ah, ch] = ep.split(':');
  const dk = crypto.pbkdf2Sync(s, Buffer.from(sh,'hex'), 100000, 32, 'sha512');
  const d = crypto.createDecipheriv('aes-256-gcm', dk, Buffer.from(ih,'hex'));
  d.setAuthTag(Buffer.from(ah,'hex'));
  return Buffer.concat([d.update(Buffer.from(ch,'hex')), d.final()]).toString('utf8');
}
const creds = JSON.parse(decrypt(store.vertexCredsEncrypted, encSecret));

async function getToken() {
  const auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return (await (await auth.getClient()).getAccessToken()).token;
}
async function opt(fp) {
  return (await sharp(fs.readFileSync(fp)).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer()).toString('base64');
}

async function run() {
  const target64 = await opt(process.argv[2]);
  const token = await getToken();
  const P = creds.project_id;
  const H = {'Authorization':`Bearer ${token}`,'Content-Type':'application/json'};
  const S = [{category:'HARM_CATEGORY_HARASSMENT',threshold:'OFF'},{category:'HARM_CATEGORY_HATE_SPEECH',threshold:'OFF'},{category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'OFF'},{category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'OFF'},{category:'HARM_CATEGORY_CIVIC_INTEGRITY',threshold:'OFF'}];

  console.log('Pink cosplay onto busty Messi girl — proportion preservation test');

  const desc = 'A Pokémon-themed pastel pink ribbed knit activewear matching set:\n- A soft baby-pink ribbed jersey sports bralette with wide shoulder straps\n- Matching baby-pink ribbed jersey mini athletic shorts\n- Pink novelty headband with plush animal ears and a red-white round ornament\n- Pastel pink ribbed thigh-high athletic socks';

  const parts = [
    {text: `[PERSON REFERENCE — CRITICAL: preserve EVERYTHING exactly]\nYou MUST preserve:\n- This exact face, hair color, hair style, skin tone\n- This person's EXACT body proportions — bust size, waist, hips must be IDENTICAL to this photo\n- The outfit must conform to and accentuate the person's natural figure exactly as it is\n- Same pose and camera angle`},
    {inlineData:{mimeType:'image/jpeg',data:target64}},
    {text: `Professional activewear fashion editorial.\n\nOUTFIT TO APPLY:\n${desc}\n\nThe entire ensemble is in soft baby pink ribbed knit fabric.\n\nCRITICAL RULES:\n1. The person's body proportions are SACRED — do not reduce, flatten, or alter the bust, waist, or hip measurements in ANY way\n2. The sports bralette must fit this person's actual bust size — it stretches to accommodate, it does not compress\n3. Face, hair, makeup, skin = pixel-perfect match to reference\n4. Same outdoor setting, same lighting, same pose\n5. The athletic shorts sit at the same rise as the reference garment\n6. Magazine-quality editorial photography\n7. No watermarks, no text overlays`},
  ];

  console.log('Generating...');
  const gResp = await fetch(`https://aiplatform.googleapis.com/v1/projects/${P}/locations/global/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`,{
    method:'POST',headers:H,body:JSON.stringify({
      contents:[{role:'user',parts}],
      generationConfig:{responseModalities:['TEXT','IMAGE'],temperature:1.0,imageConfig:{aspectRatio:'4:5',imageSize:'1K'}},
      safetySettings:S,
      systemInstruction:{role:'user',parts:[{text:'Professional activewear and athleisure fashion photography AI. You specialize in styling activewear on models of all body types, always preserving their natural proportions.'}]},
    }),signal:AbortSignal.timeout(180000)
  });
  const gd = await gResp.json();
  const reason = gd?.candidates?.[0]?.finishReason || 'NONE';
  console.log('finishReason:', reason);
  for (const p of gd?.candidates?.[0]?.content?.parts||[]) {
    if (p.inlineData?.data) {
      fs.writeFileSync(path.join(__dirname,'outfit_swap_result.png'), Buffer.from(p.inlineData.data,'base64'));
      console.log('SUCCESS!');
      process.exit(0);
    }
  }
  console.error('Failed:', reason);
  process.exit(1);
}
run().catch(e=>{console.error(e.message);process.exit(1)});
