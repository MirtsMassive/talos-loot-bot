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

const sharp = require('sharp'); // (not currently used, but kept)

// ---- Image generation (robust) ----
async function generateImageFromPrompt(prompt, fileName, rarity) {
  try {
    const image = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `${prompt} No text or labels in the image.`,
      n: 1,
      size: '1024x1024',
      response_format: 'url'
    });

    const url = image.data[0].url;
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();

    const baseImage = await loadImage(Buffer.from(buffer));

    // rarity may be undefined if caller forgot; guard it
    const rarityKey = (rarity || 'Common').toLowerCase();
    const framePath = path.join('frames', `frame_${rarityKey}.png`);

    // compose
    const canvas = createCanvas(1024, 1024);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(baseImage, 0, 0, 1024, 1024);

    if (fs.existsSync(framePath)) {
      const frameImage = await loadImage(framePath);
      ctx.drawImage(frameImage, 0, 0, 1024, 1024);
    } else {
      console.warn(`❗ Frame not found for rarity: ${rarityKey} (looked for ${framePath})`);
    }

    const finalBuffer = canvas.toBuffer('image/png');
    const finalPath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(finalPath, finalBuffer);

    return finalPath;
  } catch (err) {
    console.error('❌ Error generating image:', err);
    // still write a placeholder to avoid crashes later
    const fallbackPath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(fallbackPath, Buffer.from(''));
    return fallbackPath;
  }
}

async function generateChestDescription(rarity) {
  const prompt = `Write a fantasy-style loot chest description for a ${rarity.toLowerCase()} rarity chest. Do not describe specific items. Make it vivid and atmospheric. Keep under 100 words.`;
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 150,
    temperature: 0.85
  });
  return response.choices[0].message.content.trim();
}

// ---- DROP CHEST ----
async function dropChest(guildId, manual = false) {
  try {
    const rarity = rollRarity();
    const score = getRarityScore(rarity);
    const desc = await generateChestDescription(rarity);
    const id = Date.now().toString();

    const chestPrompt = `A fantasy loot chest of ${rarity} rarity. ${desc}`;
    // ✅ pass rarity so frame overlay works; avoids undefined errors
    const imagePath = await generateImageFromPrompt(chestPrompt, `${id}_chest.png`, rarity);

    // ✅ define chest before any usage
    const chest = {
      id,
      rarity,
      score,
      desc,
      imagePath,
      claimedBy: null,        // later becomes array after items generated
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
        `🎁 **A loot chest drops!**\n` +
        `**ID:** \`${id}\`\n` +
        `**Rarity:** ${rarity} *(Score: ${score})*\n` +
        `**Description:** ${desc}\n\n` +
        `Use \`!open ${id}\` to open it (costs 1 key).`,
      files: [image]
    });
    console.log(`📤 Chest ${id} sent successfully.`);
  } catch (err) {
    console.error(`❌ Error in dropChest for guild ${guildId}:`, err);
  }
}

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
    console.log(`!usedrop triggered by ${msg.author.username}`);

    await dropChest(guildId, true);
    console.log(`dropChest completed for ${msg.author.username}`);
  }

  if (command === '!drop') {
    console.log(`!drop command received from ${msg.author.username}`);

    const hasRoleAccess = msg.member.roles.cache.some(role =>
      ALLOWED_ROLE_IDS.includes(role.id)
    );
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
          content: `Create 2 unique fantasy loot items for a ${chest.rarity} chest. Each should include:
- Name (1-4 words)
- Description (max 35 words)
- Score: number between 10000–99999

Format:
1. "Item Name" (Rarity: X | Score: XXXXX)
Description: ...`
        }],
        temperature: 0.9,
        max_tokens: 600
      });

      const lines = loot.choices[0].message.content.trim().split(/\n(?=\d+\.)/g);

      const items = await Promise.all(lines.map(async (entry, idx) => {
        const [header, description] = (entry || '').split('\n');

        const match = header && header.match(/"(.*?)"\s*\(Rarity:\s*(\w+)\s*\|\s*Score:\s*(\d+)\)/);
        const name = match?.[1] || `Unknown Item ${idx + 1}`;
        const rarity = match?.[2] || chest.rarity;
        const score = parseInt(match?.[3] || `${getRarityScore(rarity)}`, 10);

        const shortDesc = (description || '').split(': ')[1] || 'Mysterious artifact from distant storms.';
        const imagePrompt = `${shortDesc}. Fantasy item. No text, no characters in image.`;

        const imagePath = await generateImageFromPrompt(imagePrompt, `${chest.id}_item${idx + 1}.png`, rarity);

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
      chest.claimedBy = []; // initialize as list for claim tracking
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

    // Find the most recent unclaimed chest with items for this user context
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

  // ⭐ SCRAPALL command
  if (command === '!scrapall') {
    const userInv = inventories[userId] || [];
    if (!userInv.length) return msg.reply("📦 Your inventory is already empty.");

    // Tally points and counts by rarity
    let totalPoints = 0;
    const counts = {}; // { rarity: count }
    for (const item of userInv) {
      const val = getScrapValue(item.rarity);
      totalPoints += val;
      counts[item.rarity] = (counts[item.rarity] || 0) + 1;
    }

    // Award points and clear inventory
    points[userId] = (points[userId] || 0) + totalPoints;
    inventories[userId] = [];
    saveAll();

    // Make a readable breakdown
    const breakdown = Object.entries(counts)
      .sort((a, b) => (b[1] - a[1])) // most frequent first
      .map(([rarity, count]) => `${getColor(rarity)} ${rarity} × ${count}`)
      .join(', ');

    msg.reply(
      `♻️ Scrapped **${userInv.length}** item(s) for **${totalPoints}** points!\n` +
      (breakdown ? `**Breakdown:** ${breakdown}` : '')
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
