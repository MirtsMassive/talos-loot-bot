const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js'); 
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { createCanvas, loadImage } = require('canvas');

// ✅ Check that OPENAI_API_KEY is present before creating the OpenAI client
console.log("🔑 OPENAI_API_KEY loaded:", !!process.env.OPENAI_API_KEY);

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is not set in environment variables.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_ROLE_IDS = ['622845214247223366','454313119406227457','749118349874823260','1402331068899790918'];
const KEYMASTER_ROLE_IDS = ['622845214247223366','454313119406227457'];

const chestRarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Artifact'];
const rarityChances = [40, 25, 15, 10, 5, 4.5, 0.5];
const rarityColors = {
  Common: '🟤',
  Uncommon: '🟢',
  Rare: '🔵',
  Epic: '🟣',
  Legendary: '🟡',
  Mythic: '⚔',
  Artifact: '👁‍🗨'
};

let chests = [];
let keys = new Map();
let inventories = {};
let communityInventory = [];
let userCooldowns = new Map();
let userOpenLock = new Set();
let points = {};

let serverConfig = {};
if (fs.existsSync('serverConfig.json')) serverConfig = JSON.parse(fs.readFileSync('serverConfig.json'));
if (fs.existsSync('inventory.json')) inventories = JSON.parse(fs.readFileSync('inventory.json'));
if (fs.existsSync('community.json')) communityInventory = JSON.parse(fs.readFileSync('community.json'));
if (fs.existsSync('points.json')) points = JSON.parse(fs.readFileSync('points.json'));

// 🔁 Description history for uniqueness
let descHistory = [];
if (fs.existsSync('desc_history.json')) {
  try { descHistory = JSON.parse(fs.readFileSync('desc_history.json', 'utf8')) || []; }
  catch { descHistory = []; }
}

// ensure temp dir exists for images
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function saveAll() {
  fs.writeFileSync('serverConfig.json', JSON.stringify(serverConfig, null, 2));
  fs.writeFileSync('inventory.json', JSON.stringify(inventories, null, 2));
  fs.writeFileSync('community.json', JSON.stringify(communityInventory, null, 2));
  fs.writeFileSync('points.json', JSON.stringify(points, null, 2));
  fs.writeFileSync('desc_history.json', JSON.stringify(descHistory.slice(-200), null, 2));
}

function getScrapValue(rarity) {
  return {
    Common: 10,
    Uncommon: 20,
    Rare: 40,
    Epic: 60,
    Legendary: 80,
    Mythic: 100,
    Artifact: 200
  }[rarity] || 5;
}

function rollRarity() {
  const roll = Math.random() * 100;
  let total = 0;
  for (let i = 0; i < rarityChances.length; i++) {
    total += rarityChances[i];
    if (roll <= total) return chestRarities[i];
  }
  return 'Common';
}

function getRarityScore(rarity) {
  const base = {
    Common: 10000, Uncommon: 20000, Rare: 40000,
    Epic: 60000, Legendary: 80000, Mythic: 90000, Artifact: 99000
  }[rarity];
  return base + Math.floor(Math.random() * (base / 2));
}

function getColor(rarity) {
  return rarityColors[rarity] || '⬜';
}

/* ──────────────────────────────────────────────────────────────────────────
   Safety sanitizer to avoid DALL·E policy trips + risky word replacements
   ────────────────────────────────────────────────────────────────────────── */
const RISKY_TERMS = [
  'gun','pistol','rifle','bullet','shotgun','sniper','grenade','mine','tank','bomb',
  'blood','gore','guts','severed','decapitated','corpse','kill','murder',
  'nude','naked','lingerie','seductive','erotic','sexual',
  'drug','cocaine','heroin','marijuana','alcohol','vodka',
  'nazi','hitler','isis','terrorist','politics','political',
  'logo','brand','trademark'
];
const SAFE_REPLACEMENTS = {
  gun: 'arcane wand',
  pistol: 'arcane wand',
  rifle: 'enchanted longbow',
  bullet: 'spark of magic',
  shotgun: 'stormcaster',
  sniper: 'farseeing bow',
  grenade: 'aether orb',
  mine: 'trap rune',
  tank: 'golem',
  bomb: 'volatile glyph',
  blood: 'ether',
  gore: 'shadow',
  guts: 'ether',
  severed: 'broken',
  decapitated: 'shattered',
  corpse: 'statue',
  kill: 'banish',
  murder: 'banish',
  nude: 'ancient',
  naked: 'ancient',
  lingerie: 'silken',
  seductive: 'alluring',
  erotic: 'mystical',
  sexual: 'mystical',
  drug: 'potion',
  cocaine: 'powder',
  heroin: 'elixir',
  marijuana: 'herb',
  alcohol: 'elixir',
  vodka: 'elixir',
  nazi: 'ancient',
  hitler: 'ancient',
  isis: 'ancient',
  terrorist: 'raider',
  politics: 'affairs',
  political: 'public',
  logo: 'mark',
  brand: 'mark',
  trademark: 'mark'
};

function sanitizeForImage(text) {
  let t = (text || '').replace(/[\"<>]/g, '');
  // Lower-case replace by word boundary
  for (const k of RISKY_TERMS) {
    const re = new RegExp(`\\b${k}\\b`, 'gi');
    t = t.replace(re, SAFE_REPLACEMENTS[k] || '');
  }
  // Remove any mention suggesting readable text
  t = t.replace(/\b(text|title|label|caption|typography|words?)\b/gi, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

/* ──────────────────────────────────────────────────────────────────────────
   IMAGE PROMPT BUILDERS
   ────────────────────────────────────────────────────────────────────────── */

// Chest image prompt: USE the exact generated description (sanitized) so image matches text
function buildChestImagePromptFromDesc(desc, rarity) {
  const clean = sanitizeForImage(desc || '');
  return [
    `Closed fantasy treasure chest matching this description: ${clean}`,
    `Grandeur and craftsmanship should naturally reflect ${rarity} rarity (more elaborate for higher rarities).`,
    `Exterior only. Closed lid. No interior or contents.`,
    `Hand-painted high-fantasy illustration / stylized 3D render, dramatic lighting, centered, high detail.`,
    `ABSOLUTE RULES: no readable text; no letters or numbers; no labels, logos, UI, blueprints, diagrams, posters, or watermarks.`,
    `If runes appear, they must be abstract and not form legible writing.`,
    `Square composition.`
  ].join(' ');
}

// Item image prompt with strong safety language
function buildFantasyItemImagePrompt(name, shortDesc, rarity) {
  const cleanName = sanitizeForImage(name || '');
  const cleanDesc = sanitizeForImage(shortDesc || '');

  return [
    `High-fantasy magical item icon of "${cleanName}" (${rarity} rarity). ${cleanDesc}.`,
    `Single object only, centered on a clean neutral gradient background.`,
    `Hand-painted illustration style; stylized fantasy depiction; non-functional portrayal.`,
    `No modern objects or real-world weapons; no gore; no adult themes; no politics or real religions.`,
    `ABSOLUTE RULES: no text, letters, numbers, runes, labels, logos, UI, blueprints, diagrams, posters, annotations, or watermarks.`,
    `Do not depict any chest, box, crate, packaging, table, scroll page, or scene; focus only on the item.`,
    `No people or hands. Square composition.`
  ].join(' ');
}

/* ──────────────────────────────────────────────────────────────────────────
   IMAGE GENERATION (with safe retry + edge-crop to remove stray captions)
   ────────────────────────────────────────────────────────────────────────── */
async function generateImageFromPrompt(prompt, fileName) {
  const tryOnce = async (p) => {
    const image = await openai.images.generate({
      model: 'dall-e-3',
      prompt: p,
      n: 1,
      size: '1024x1024',
      response_format: 'url'
    });

    const url = image.data[0].url;
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const baseImage = await loadImage(Buffer.from(buffer));

    const W = 1024;
    const H = 1024;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Light uniform crop (6%) to shave off any stray titles/borders DALL·E may add
    const CROP = 0.06;
    const sx = Math.floor(W * CROP);
    const sy = Math.floor(H * CROP);
    const sw = Math.floor(W * (1 - CROP * 2));
    const sh = Math.floor(H * (1 - CROP * 2));

    ctx.drawImage(baseImage, sx, sy, sw, sh, 0, 0, W, H);

    const finalBuffer = canvas.toBuffer('image/png');
    const finalPath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(finalPath, finalBuffer);
    return finalPath;
  };

  try {
    return await tryOnce(prompt);
  } catch (err) {
    const isPolicy = (err?.status === 400) || /safety|policy|content/i.test(String(err?.message || ''));
    if (isPolicy) {
      const safer = [
        sanitizeForImage(prompt),
        'Stylized high-fantasy illustration of a single object.',
        'No text, no letters, no numbers, no logos, UI, people, gore, adult themes, politics, or real religions.',
        'Neutral gradient background, centered composition.'
      ].join(' ');
      try {
        return await tryOnce(safer);
      } catch (e2) {
        console.error('Policy-safe retry failed:', e2);
      }
    } else {
      console.error('Image generation failed:', err);
    }
    const fallbackPath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(fallbackPath, Buffer.from(''));
    return fallbackPath;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   DESCRIPTION UNIQUENESS HELPERS
   ────────────────────────────────────────────────────────────────────────── */
function normalizeForSim(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}
function jaccardSim(a, b) {
  const A = new Set(normalizeForSim(a));
  const B = new Set(normalizeForSim(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/* ──────────────────────────────────────────────────────────────────────────
   TEXT: UNIQUE CHEST DESCRIPTION (≤60 words, exterior-only)
   ────────────────────────────────────────────────────────────────────────── */
async function generateChestDescription(rarity) {
  const rules = `
Write a single-paragraph fantasy description of a CLOSED treasure chest.
Constraints:
- 45–60 words (concise but vivid).
- Describe EXTERIOR ONLY. Do NOT mention opening, lids moving, the interior/inside, contents, or what it holds.
- No future actions or instructions.
- Language and sense of grandeur should scale naturally with rarity: ${rarity}.
- Vary syntax and imagery; avoid clichés and repeated phrasing.
Return ONLY the description text.`;

  const prompt = rules.trim();

  const MAX_TRIES = 4;
  const SIM_THRESHOLD = 0.58;
  const recent = descHistory.slice(-80);

  for (let i = 0; i < MAX_TRIES; i++) {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 180,
      temperature: 0.95,
      presence_penalty: 0.7,
      frequency_penalty: 0.45
    });

    let text = (resp.choices?.[0]?.message?.content || '').trim();

    // enforce 60-word cap
    const words = text.split(/\s+/);
    if (words.length > 60) text = words.slice(0, 60).join(' ').replace(/[.,;:!?-]*$/, '.');

    // block interior/opening mentions
    const banned = /\b(open|opened|opening|inside|interior|within|contents?|reveals?|revealing|contains?)\b/i;
    if (banned.test(text)) continue;

    const tooSimilar = recent.some(h => jaccardSim(h.text, text) >= SIM_THRESHOLD);
    if (!tooSimilar) {
      descHistory.push({ rarity, text, ts: Date.now() });
      saveAll();
      return text;
    }
  }

  // Fallback (rare)
  const fallbackText = `A closed ${rarity.toLowerCase()} chest rests in the light, exterior gleaming with careful craft and a quiet aura of promise.`;
  descHistory.push({ rarity, text: fallbackText, ts: Date.now() });
  saveAll();
  return fallbackText;
}

/* ──────────────────────────────────────────────────────────────────────────
   DROP CHEST
   ────────────────────────────────────────────────────────────────────────── */
async function dropChest(guildId, manual = false) {
  try {
    const rarity = rollRarity();
    const score = getRarityScore(rarity);
    const desc = await generateChestDescription(rarity);
    const id = Date.now().toString();

    // 🧲 Use the description itself to create the image prompt (so they match)
    const chestPrompt = buildChestImagePromptFromDesc(desc, rarity);
    const imagePath = await generateImageFromPrompt(chestPrompt, `${id}_chest.png`);

    const chest = {
      id,
      rarity,
      score,
      desc,
      imagePath,
      claimedBy: null,
      items: [],
      guildId,
      timestamp: Date.now(),
    };

    chests.push(chest);
    console.log(`📦 Chest created with ID ${id}`);

    const channelId = serverConfig[guildId];
    if (!channelId) {
      console.warn(`⚠️ No drop channel set for guild ${guildId}`);
      return;
    }

    const channel = await client.channels.fetch(channelId).catch(err => {
      console.error(`❌ Failed to fetch channel ${channelId}:`, err);
      return null;
    });
    if (!channel) return;

    const image = new AttachmentBuilder(imagePath);
    await channel.send({
      content:
`🎁 **A loot chest drops!**
**ID:** \`${id}\`
**Rarity:** ${rarity} *(Score: ${score})*
**Description:** ${desc}

Use \`!open ${id}\` to open it (costs 1 key).`,
      files: [image]
    });
    console.log(`📤 Chest ${id} sent successfully.`);
  } catch (err) {
    console.error(`❌ Error in dropChest for guild ${guildId}:`, err);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   COMMANDS
   ────────────────────────────────────────────────────────────────────────── */
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const args = msg.content.trim().split(' ');
  const command = args.shift().toLowerCase();
  const userId = msg.author.id;
  const guildId = msg.guild.id;

  if (command === '!usedrop') {
    const userKeys = keys.get(userId) || 0;

    if (userKeys < 5) {
      return msg.reply('❌ You need **5 keys** to summon a chest.');
    }

    keys.set(userId, userKeys - 5);
    saveAll();

    msg.reply('🧿 A chest has been summoned using your keys!');
    await dropChest(guildId, true);
  }

  if (command === '!drop') {
    const hasRoleAccess = msg.member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id));
    if (!hasRoleAccess) {
      return msg.reply('❌ You need a specific role to use this command.');
    }
    await dropChest(guildId, true);
  }

  if (!keys.has(userId)) keys.set(userId, 3);

  if (command === '!setchannel') {
    serverConfig[guildId] = msg.channel.id;
    saveAll();
    return msg.reply(`✅ This channel is now set as the drop zone for this server.`);
  }

  if (command === '!open') {
    const now = Date.now();

    if (userOpenLock.has(userId)) {
      return msg.reply('🛑 You are already opening a chest. Please wait.');
    }

    const lastUsed = userCooldowns.get(userId) || 0;
    if (now - lastUsed < 60000) {
      const remaining = Math.ceil((60000 - (now - lastUsed)) / 1000);
      return msg.reply(`⏳ Please wait ${remaining}s before using \`!open\` again.`);
    }

    const id = args[0];
    const chest = chests.find(c => c.id === id && c.guildId === guildId);
    if (!chest) return msg.reply('❌ That chest does not exist.');

    if (chest.claimedBy && chest.claimedBy !== userId) {
      return msg.reply('🛑 This chest has already been opened by someone else.');
    }

    const fiveMinutes = 5 * 60 * 1000;
    if (chest.claimedBy && chest.claimedBy !== userId && now - chest.timestamp < fiveMinutes) {
      const remaining = Math.ceil((fiveMinutes - (now - chest.timestamp)) / 1000);
      return msg.reply(`⏳ This chest was opened recently. Try again in ${remaining}s.`);
    }

    const userKeys = keys.get(userId) || 0;
    if (userKeys < 1) return msg.reply('🔐 You have **0** keys.');

    userCooldowns.set(userId, now);
    userOpenLock.add(userId);

    try {
      const loot = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content:
`Create 2 unique **high-fantasy, medieval** loot items for a ${chest.rarity} chest.
HARD RULES:
- Only fantasy/mystical artifacts, weapons, armor, trinkets, tomes, crystals, etc.
- No modern objects, no brands, no product photography, no sci-fi guns.
- Avoid words that imply gore, blood, torture, drugs, adult/sexual content, real-world politics or religions, or modern brands/logos.
- Keep language medieval/magical.

For each item provide:
- Name (1–4 words)
- Description (max 35 words, fantasy tone)
- Score: number between 10000–99999

Format exactly:
1. "Item Name" (Rarity: X | Score: XXXXX)
Description: ...`
        }],
        temperature: 0.85,
        max_tokens: 600
      });

      const lines = loot.choices[0].message.content.trim().split(/\n(?=\d+\.)/g);

      const items = await Promise.all(lines.map(async (entry, idx) => {
        const [header, description] = (entry || '').split('\n');

        const match = header && header.match(/"(.*?)"\s*\(Rarity:\s*(\w+)\s*\|\s*Score:\s*(\d+)\)/);
        const name = match?.[1] || `Unknown Item ${idx + 1}`;
        const rarity = match?.[2] || chest.rarity;
        const score = parseInt(match?.[3] || `${getRarityScore(rarity)}`, 10);

        const shortDesc = (description || '').split(': ')[1] || 'Ancient relic infused with quiet power.';
        const imagePrompt = buildFantasyItemImagePrompt(name, shortDesc, rarity);

        const imagePath = await generateImageFromPrompt(imagePrompt, `${chest.id}_item${idx + 1}.png`);

        return {
          idx: idx + 1,
          name,
          rarity,
          emoji: getColor(rarity),
          score: Number.isFinite(score) ? score : getRarityScore(rarity),
          description: shortDesc,
          imagePath
        };
      }));

      chest.items = items;
      chest.claimedBy = [];
      keys.set(userId, userKeys - 1);

      const formatted = items.map(i =>
        `**${i.idx}.** ${i.emoji} "${i.name}" (Rarity: ${i.rarity} | Score: ${i.score})\n${i.description}`
      ).join('\n\n');

      const itemFiles = items.map(i => new AttachmentBuilder(i.imagePath).setName(path.basename(i.imagePath)));
      msg.channel.send({ content: `🗝️ You opened the chest! Use \`!claim <itemNumber>\` to take 1 item.\n\n${formatted}`, files: itemFiles });
    } catch (err) {
      console.error(err);
      msg.reply('⚠️ Error generating loot. Please wait and try again.');
    } finally {
      userOpenLock.delete(userId);
    }
  }

  if (command === '!claim') {
    const number = parseInt(args[0], 10);
    if (isNaN(number)) return msg.reply('Usage: `!claim <itemNumber>`');

    const chest = [...chests]
      .reverse()
      .find(c => c.guildId === guildId && c.items?.length && !inventories[userId]?.some(i => i.sourceChest === c.id));

    if (!chest) return msg.reply("❌ You don't have loot available to claim.");

    if (!chest.claimedBy) chest.claimedBy = [];

    if (chest.claimedBy.includes(userId)) {
      return msg.reply("🛑 You've already claimed from this chest.");
    }

    const item = chest.items.find(i => i.idx === number);
    if (!item) return msg.reply("❌ Invalid item number.");

    const claimedItem = { ...item, sourceChest: chest.id };
    if (!inventories[userId]) inventories[userId] = [];
    inventories[userId].push(claimedItem);
    communityInventory.push({ ...claimedItem, user: msg.author.username });

    chest.claimedBy.push(userId);
    saveAll();

    msg.channel.send(`✅ Claimed ${item.emoji} **"${item.name}"**!`);
  }

  if (command === '!inventory') {
    const inv = inventories[userId] || [];
    if (!inv.length) return msg.reply("📦 Your inventory is empty.");

    const list = inv.map((i, idx) =>
      `**${idx + 1}.** ${getColor(i.rarity)} "${i.name}" *(Rarity: ${i.rarity}, Score: ${i.score})*`
    ).join('\n');

    const imageFiles = inv
      .filter(i => i.imagePath && fs.existsSync(i.imagePath))
      .map(i => new AttachmentBuilder(i.imagePath));

    msg.reply({ content: `🧾 **Your Inventory:**\n${list}`, files: imageFiles });
  }

  if (command === '!view') {
    const target = msg.mentions.users.first();
    if (!target) return msg.reply('Usage: `!view @user`');

    const inv = inventories[target.id] || [];
    if (!inv.length) return msg.reply(`📦 ${target.username}'s inventory is empty.`);

    const list = inv.map((i, idx) =>
      `**${idx + 1}.** ${getColor(i.rarity)} "${i.name}" *(Rarity: ${i.rarity}, Score: ${i.score})*`
    ).join('\n');

    const imageFiles = inv
      .filter(i => i.imagePath && fs.existsSync(i.imagePath))
      .map(i => new AttachmentBuilder(i.imagePath));

    msg.reply({ content: `🧾 **${target.username}'s Inventory:**\n${list}`, files: imageFiles });
  }

  if (command === '!community') {
    if (!communityInventory.length) return msg.channel.send("👥 No loot claimed yet.");
    const leaderboard = [...communityInventory]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((i, idx) => `**${idx + 1}.** ${i.user} — ${getColor(i.rarity)} "${i.name}" *(Rarity: ${i.rarity}, Score: ${i.score})*`)
      .join('\n');
    msg.channel.send(`🏆 **Community Leaderboard:**\n${leaderboard}`);
  }

  if (command === '!keys') {
    const count = keys.get(userId) || 0;
    msg.channel.send(`🔑 You have **${count}** key(s).`);
  }

  // ⭐ SCRAP command
  if (command === '!scrap') {
    const index = parseInt(args[0], 10);
    const userInv = inventories[userId] || [];
    if (isNaN(index) || index < 1 || index > userInv.length) {
      return msg.reply('Usage: `!scrap <itemNumber>`');
    }

    const item = userInv.splice(index - 1, 1)[0];
    const value = getScrapValue(item.rarity);
    points[userId] = (points[userId] || 0) + value;

    saveAll();
    msg.reply(`♻️ Scrapped ${item.emoji} **"${item.name}"** for **${value}** points!`);
  }

  // ⭐ SCRAPALL command (clean breakdown)
  if (command === '!scrapall') {
    const userInv = inventories[userId] || [];
    if (!userInv.length) return msg.reply("📦 Your inventory is already empty.");

    let totalPoints = 0;
    const counts = {};
    for (const item of userInv) {
      const val = getScrapValue(item.rarity);
      totalPoints += val;
      counts[item.rarity] = (counts[item.rarity] || 0) + 1;
    }

    points[userId] = (points[userId] || 0) + totalPoints;
    const totalItems = userInv.length;
    inventories[userId] = [];
    saveAll();

    const lines = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([rarity, qty]) => `${getColor(rarity)} ${rarity} - ${qty}`)
      .join('\n');

    msg.reply(
      `♻️ Scrapped **${totalItems}** item(s) for **${totalPoints}** points!\n\n` +
      `Scrapped:\n${lines}`
    );
  }

  // ⭐ POINTS command
  if (command === '!points') {
    const balance = points[userId] || 0;
    msg.reply(`💠 You have **${balance}** points.`);
  }

  // ⭐ REDEEMKEYS command
  if (command === '!redeemkeys') {
    const amount = parseInt(args[0], 10);
    if (isNaN(amount) || amount < 1) {
      return msg.reply('Usage: `!redeemkeys <amount>`');
    }

    const cost = 100 * amount;
    const balance = points[userId] || 0;

    if (balance < cost) {
      return msg.reply(`❌ You need **${cost}** points to redeem **${amount}** key(s). You only have **${balance}**.`);
    }

    points[userId] -= cost;
    keys.set(userId, (keys.get(userId) || 0) + amount);
    saveAll();
    msg.reply(`✅ Redeemed **${amount}** key(s) for **${cost}** points!`);
  }

  if (command === '!givekeys') {
    const hasKeyPermission = msg.member.roles.cache.some(role => KEYMASTER_ROLE_IDS.includes(role.id));
    if (!hasKeyPermission) return msg.reply('❌ You don\'t have permission to give keys.');

    const target = args[0]?.replace(/[<@!>]/g, '');
    const amount = parseInt(args[1], 10);
    if (!target || isNaN(amount)) return msg.reply('Usage: `!givekeys @user amount`');

    const current = keys.get(target) || 0;
    keys.set(target, current + amount);
    msg.channel.send(`✅ Gave ${amount} key(s) to <@${target}>.`);
  }

  if (command === '!help') {
    const hasRoleAccess = msg.member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id));
    const hasKeyPermission = msg.member.roles.cache.some(role => KEYMASTER_ROLE_IDS.includes(role.id));

    let helpText = `📜 **TALOS Loot Bot Commands**\n\n` +
      `🎁 \`!open <chestId>\` — Open a chest using 1 key\n` +
      `🧾 \`!claim <itemNumber>\` — Claim an item from an opened chest\n` +
      `📦 \`!inventory\` — View your personal loot inventory\n` +
      `♻️ \`!scrap <itemNumber>\` — Scrap an item for points\n` +
      `♻️ \`!scrapall\` — Scrap your entire inventory for points\n` +
      `💠 \`!points\` — View your point balance\n` +
      `🔁 \`!redeemkeys <amount>\` — Convert points into keys\n` +
      `🕵️ \`!view @user\` — View another user’s inventory\n` +
      `🏆 \`!community\` — See the top 10 loot scores\n` +
      `🔮 \`!usedrop\` — Use 5 keys to summon a loot chest\n` +
      `🔑 \`!keys\` — Check your key count\n`;

    if (hasRoleAccess) {
      helpText += `\n💠 \`!drop\` — Manually spawn a loot chest\n📌 \`!setchannel\` — Set this channel as the drop zone\n`;
    }

    if (hasKeyPermission) {
      helpText += `➕ \`!givekeys @user <amount>\` — Grant keys to another user\n`;
    }

    msg.reply(helpText);
  }
});

client.once('ready', () => {
  console.log(`🟢 Logged in as ${client.user.tag}`);

  function scheduleRandomDrops() {
    const dropTimes = [];

    while (dropTimes.length < 3) {
      const randomHour = Math.floor(Math.random() * 24);
      const randomMinute = Math.floor(Math.random() * 60);
      const timestamp = new Date();
      timestamp.setHours(randomHour, randomMinute, 0, 0);

      // If time already passed today, push to tomorrow
      if (timestamp.getTime() <= Date.now()) {
        timestamp.setDate(timestamp.getDate() + 1);
      }

      // Ensure at least 30 minutes apart
      if (dropTimes.every(t => Math.abs(t - timestamp.getTime()) >= 30 * 60 * 1000)) {
        dropTimes.push(timestamp.getTime());
      }
    }

    dropTimes.forEach(time => {
      const delay = time - Date.now();
      if (delay > 0) {
        setTimeout(async () => {
          for (const guildId of Object.keys(serverConfig)) {
            await dropChest(guildId);
          }
          scheduleRandomDrops(); // Reschedule after all have dropped
        }, delay);
      }
    });
  }

  scheduleRandomDrops();
});

client.login(TOKEN);
