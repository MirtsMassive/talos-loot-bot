const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const fetch = require('node-fetch').default;
dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_IDS = ['180163503980544001']; // Add your Discord ID(s)

const chestRarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Artifact'];
const rarityChances = [40, 25, 15, 10, 5, 4.5, 0.5];
const rarityColors = {
  Common: '🟤',
  Uncommon: '🟢',
  Rare: '🔵',
  Epic: '🟣',
  Legendary: '🟡',
  Mythic: '🔴',
  Artifact: '🌈'
};

let chests = [];
let keys = new Map();
let inventories = {};
let communityInventory = [];
let userCooldowns = new Map();
let userOpenLock = new Set();

let serverConfig = {};
if (fs.existsSync('serverConfig.json')) serverConfig = JSON.parse(fs.readFileSync('serverConfig.json'));
if (fs.existsSync('inventory.json')) inventories = JSON.parse(fs.readFileSync('inventory.json'));
if (fs.existsSync('community.json')) communityInventory = JSON.parse(fs.readFileSync('community.json'));

function saveAll() {
  fs.writeFileSync('serverConfig.json', JSON.stringify(serverConfig, null, 2));
  fs.writeFileSync('inventory.json', JSON.stringify(inventories, null, 2));
  fs.writeFileSync('community.json', JSON.stringify(communityInventory, null, 2));
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

async function generateImageFromPrompt(prompt, fileName) {
  const image = await openai.images.generate({
    model: 'dall-e-3',
    prompt: prompt + ' No text or labels in the image.',
    n: 1,
    size: '1024x1024',
    response_format: 'url'
  });

  const url = image.data[0].url;
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const filePath = path.join('temp', fileName);
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
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

async function dropChest(guildId, manual = false) {
  const rarity = rollRarity();
  const score = getRarityScore(rarity);
  const desc = await generateChestDescription(rarity);
  const id = Date.now().toString();

  const chestPrompt = `A fantasy loot chest of ${rarity} rarity. ${desc}`;
  const imagePath = await generateImageFromPrompt(chestPrompt, `${id}_chest.png`);

  const chest = {
    id,
    rarity,
    score,
    desc,
    imagePath,
    claimedBy: null,
    items: [],
    guildId
  };

  chests.push(chest);

  const channelId = serverConfig[guildId];
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel) return;

  const image = new AttachmentBuilder(imagePath);
  channel.send({
    content:
      `🎁 **A loot chest drops!**\n` +
      `**ID:** \`${id}\`\n` +
      `**Rarity:** ${rarity} *(Score: ${score})*\n` +
      `**Description:** ${desc}\n\n` +
      `Use \`!open ${id}\` to open it (costs 1 key).`,
    files: [image]
  });
}

client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const args = msg.content.trim().split(' ');
  const command = args.shift().toLowerCase();
  const userId = msg.author.id;
  const guildId = msg.guild.id;

  if (!keys.has(userId)) keys.set(userId, 3);

  if (command === '!setchannel') {
    serverConfig[guildId] = msg.channel.id;
    saveAll();
    return msg.reply(`✅ This channel is now set as the drop zone for this server.`);
  }

  if (command === '!drop') {
    if (!ADMIN_IDS.includes(userId)) return msg.reply('❌ Only admins can drop chests.');
    await dropChest(guildId, true);
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
    const chest = chests.find(c => c.id === id && !c.claimedBy && c.guildId === guildId);
    if (!chest) return msg.reply('❌ That chest is not available.');

    const userKeys = keys.get(userId) || 0;
    if (userKeys < 1) return msg.reply('🔐 You have **0** keys.');

    userCooldowns.set(userId, now);
    userOpenLock.add(userId);

    try {
      const loot = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: `Create 3 unique fantasy loot items for a ${chest.rarity} chest. Each should include:
- Name (1-4 words)
- Description (max 40 words)
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
        const [header, description] = entry.split('\n');
        const [, name, rarity, score] = header.match(/"(.*?)" \(Rarity: (\w+) \| Score: (\d+)\)/) || [];
        const imagePrompt = `${description?.split(': ')[1]}. Fantasy item. No text, no characters.`;
        const imagePath = await generateImageFromPrompt(imagePrompt, `${chest.id}_item${idx + 1}.png`);

        return {
          idx: idx + 1,
          name,
          rarity,
          emoji: getColor(rarity),
          score: parseInt(score),
          description: description?.split(': ')[1] || '',
          imagePath
        };
      }));

      chest.items = items;
      chest.claimedBy = userId;
      keys.set(userId, userKeys - 1);

      const formatted = items.map(i =>
        `**${i.idx}.** ${i.emoji} "${i.name}" (Rarity: ${i.rarity} | Score: ${i.score})\n${i.description}`
      ).join('\n\n');

      const itemFiles = items.map(i => new AttachmentBuilder(i.imagePath));
      msg.channel.send({ content: `🗝️ You opened the chest! Use \`!claim <itemNumber>\` to take 1 item.\n\n${formatted}`, files: itemFiles });
    } catch (err) {
      console.error(err);
      msg.reply('⚠️ Error generating loot. Please wait and try again.');
    } finally {
      userOpenLock.delete(userId);
    }
  }

  if (command === '!claim') {
    const number = parseInt(args[0]);
    if (isNaN(number)) return msg.reply('Usage: `!claim <itemNumber>`');

    const chest = chests.find(c => c.claimedBy === userId && c.items?.length);
    if (!chest) return msg.reply("❌ You don't have loot available to claim.");
    if (inventories[userId]?.some(i => i.sourceChest === chest.id)) return msg.reply("🛑 You've already claimed from this chest.");

    const item = chest.items.find(i => i.idx === number);
    if (!item) return msg.reply("❌ Invalid item number.");

    const claimedItem = { ...item, sourceChest: chest.id };
    if (!inventories[userId]) inventories[userId] = [];
    inventories[userId].push(claimedItem);
    communityInventory.push({ ...claimedItem, user: msg.author.username });
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

  if (command === '!givekeys') {
    if (!ADMIN_IDS.includes(userId)) return msg.reply('❌ No permission.');
    const target = args[0]?.replace(/[<@!>]/g, '');
    const amount = parseInt(args[1]);
    if (!target || isNaN(amount)) return msg.reply('Usage: `!givekeys @user amount`');
    const current = keys.get(target) || 0;
    keys.set(target, current + amount);
    msg.channel.send(`✅ Gave ${amount} key(s) to <@${target}>.`);
  }

  if (command === '!help') {
    const isAdmin = ADMIN_IDS.includes(userId);
    let helpText = `📜 **TALOS Loot Bot Commands**\n\n` +
      `🎁 \`!open <chestId>\` — Open a chest using 1 key\n` +
      `🧾 \`!claim <itemNumber>\` — Claim an item from an opened chest\n` +
      `📦 \`!inventory\` — View your personal loot inventory\n` +
      `🏆 \`!community\` — See the top 10 loot scores\n` +
      `🔑 \`!keys\` — Check how many keys you have\n` +
      `📌 \`!setchannel\` — Set this channel for loot drops\n`;

    if (isAdmin) {
      helpText += `\n🔧 **Admin Only**\n💠 \`!drop\` — Manually spawn a loot chest\n➕ \`!givekeys @user <amount>\` — Grant keys to any user\n`;
    }

    msg.reply(helpText);
  }
});

client.once('ready', () => {
  console.log(`🟢 Logged in as ${client.user.tag}`);
});

client.login(TOKEN);
