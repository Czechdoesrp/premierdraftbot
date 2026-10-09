// Draft Bot — one file. Node 18+, discord.js v14.
// Run:  DISCORD_TOKEN=your_token node bot.js
// Drafters pick from the dropdowns under each on-the-clock message, or with /pick.
// Draft positions come from server roles named "Drafter 1" ... "Drafter 8".
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, Events,
  ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');

const SLOTS = 8;
const PICK_SECONDS = Number(process.env.PICK_SECONDS) || 30; // time allowed per pick before auto-draft
const timers = new Map();
const lastMenu = new Map(); // per server: removes the dropdowns from the previous on-the-clock message
const FILE = path.join(__dirname, 'draft.json');

// ---------- state (one draft per server, saved to draft.json) ----------
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = {}; }
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
const blank = () => ({
  players: [], available: [], slots: {}, picks: [],
  started: false, snake: false, rounds: 0,
});
const get = (gid) => { const d = (db[gid] ??= blank()); d.gid = gid; return d; };

// ---------- draft logic ----------
const totalPicks = (d) => d.rounds * SLOTS;
const isDone = (d) => d.picks.length >= totalPicks(d) || d.available.length === 0;

function slotAt(d, index) {
  const round = Math.floor(index / SLOTS);
  const pos = index % SLOTS;
  const slot = d.snake && round % 2 === 1 ? SLOTS - pos : pos + 1;
  return { round: round + 1, pickInRound: pos + 1, slot };
}
const current = (d) => slotAt(d, d.picks.length);
const mention = (s) => (s ? (s.isRole ? `<@&${s.id}>` : `<@${s.id}>`) : '*unassigned*');
const label = (r, p) => `${r}.${String(p).padStart(2, '0')}`;

function ownsSlot(member, userId, s) {
  if (!s) return false;
  if (!s.isRole) return s.id === userId;
  const roles = member?.roles;
  if (!roles) return false;
  return Array.isArray(roles) ? roles.includes(s.id) : roles.cache.has(s.id);
}

// Position N belongs to the server role named "Drafter N" (case and spacing don't matter).
function rolesByName(guild) {
  const slots = {};
  for (const role of guild?.roles.cache.values() ?? []) {
    const m = role.name.trim().match(/^drafter\s*([1-8])$/i);
    if (m && !slots[m[1]]) slots[m[1]] = { id: role.id, isRole: true };
  }
  return slots;
}

function findPlayer(d, text) {
  const q = text.trim().toLowerCase();
  const exact = d.available.find((p) => p.toLowerCase() === q);
  if (exact) return { player: exact };
  const partial = d.available.filter((p) => p.toLowerCase().includes(q));
  if (partial.length === 1) return { player: partial[0] };
  if (partial.length > 1) return { error: `That matches more than one player: ${partial.slice(0, 8).join(', ')}` };
  const taken = d.picks.find((p) => p.player && p.player.toLowerCase() === q);
  if (taken) return { error: `**${taken.player}** was already taken at pick ${label(taken.round, taken.pickInRound)}.` };
  return { error: `No available player matches "${text}".` };
}

function onTheClock(d) {
  if (isDone(d)) return '🏁 **The draft is complete!** Use `/board` to see the results.';
  const c = current(d);
  const clock = d.deadline ? ` — auto-pick <t:${Math.ceil(d.deadline / 1000)}:R>` : '';
  return `⏱️ On the clock — pick ${label(c.round, c.pickInRound)}: slot ${c.slot} ${mention(d.slots[c.slot])}${clock}`;
}

// Dropdowns listing every available player, 25 per menu (Discord's limit), up to 5 menus.
// The menu id carries the pick number, so an old menu can never be used for a later pick.
function menus(d) {
  if (!d.started || isDone(d)) return [];
  const rows = [];
  for (let k = 0; k < d.available.length && rows.length < 5; k += 25) {
    const group = d.available.slice(k, k + 25);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`pick:${d.picks.length}:${rows.length}`)
        .setPlaceholder(`Pick: ${group[0]} … ${group[group.length - 1]}`.slice(0, 150))
        .addOptions(group.map((p) => ({ label: p.slice(0, 100), value: String(d.players.indexOf(p)) }))),
    ));
  }
  return rows;
}
const clock = (d, text) => ({ content: text, components: menus(d) });

// Post an on-the-clock message (as a command reply, or straight to the draft channel)
// and strip the dropdowns off the previous one.
async function deliver(d, payload, i) {
  const old = lastMenu.get(d.gid);
  let strip;
  if (i && (i.replied || i.deferred)) {
    const m = await i.followUp(payload);
    strip = () => i.webhook.editMessage(m.id, { components: [] });
  } else if (i) {
    await i.reply(payload);
    strip = () => i.editReply({ components: [] });
  } else {
    const channel = await client.channels.fetch(d.channelId);
    const m = await channel.send(payload);
    strip = () => m.edit({ components: [] });
  }
  if (payload.components.length) lastMenu.set(d.gid, strip); else lastMenu.delete(d.gid);
  if (old) Promise.resolve().then(old).catch(() => {});
}

// Restart the pick clock. When it runs out, the top remaining player on the list is drafted.
function arm(d) {
  clearTimeout(timers.get(d.gid));
  timers.delete(d.gid);
  if (!d.started || isDone(d)) { d.deadline = null; return; }
  d.deadline = Date.now() + PICK_SECONDS * 1000;
  timers.set(d.gid, setTimeout(() => autoPick(d.gid), PICK_SECONDS * 1000));
}

async function autoPick(gid) {
  const d = db[gid];
  if (!d || !d.started || isDone(d)) return;
  const r = makePick(d, d.available[0], null, true);
  const payload = clock(d, r.message);
  try {
    await deliver(d, payload);
  } catch (e) {
    console.error('Auto-pick was made but could not be posted:', e.message);
  }
}

function chunk(text) {
  return text.length > 1900 ? text.slice(0, 1900) + '\n…' : text;
}

// ---------- commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('draft')
    .setDescription('Run the draft (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('upload').setDescription('Load the player list (one per line, or comma separated)')
      .addAttachmentOption((o) => o.setName('file').setDescription('A .txt or .csv file of players'))
      .addStringOption((o) => o.setName('list').setDescription('Or paste players separated by commas')))
    .addSubcommand((s) => s.setName('start').setDescription('Start the draft')
      .addBooleanOption((o) => o.setName('snake').setDescription('Reverse the order every other round (default: no)'))
      .addIntegerOption((o) => o.setName('rounds').setDescription('Number of rounds (default: as many full rounds as fit)').setMinValue(1)))
    .addSubcommand((s) => s.setName('undo').setDescription('Undo the last pick'))
    .addSubcommand((s) => s.setName('skip').setDescription('Skip whoever is on the clock'))
    .addSubcommand((s) => s.setName('forcepick').setDescription('Make the pick for whoever is on the clock')
      .addStringOption((o) => o.setName('player').setDescription('Player').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('reset').setDescription('Wipe the draft completely')),
  new SlashCommandBuilder().setName('pick').setDescription('Draft a player (only works on your turn)')
    .addStringOption((o) => o.setName('player').setDescription('Player').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('available').setDescription('Show players still available'),
  new SlashCommandBuilder().setName('board').setDescription('Show the draft order and every pick so far'),
].map((c) => c.setDMPermission(false).toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // After a restart, give whoever is on the clock a fresh timer.
  for (const [gid, d] of Object.entries(db)) { d.gid = gid; arm(d); }
  save();
  for (const guild of c.guilds.cache.values()) {
    await guild.commands.set(commands).catch((e) => console.error(`Could not register in ${guild.name}:`, e.message));
  }
});
client.on(Events.GuildCreate, (guild) => guild.commands.set(commands).catch(() => {}));

// The whole pick is checked and recorded in one synchronous step (no awaits),
// so two people hitting /pick at the same moment can never both get through.
function makePick(d, text, byId, auto = false) {
  const found = findPlayer(d, text);
  if (found.error) return { error: found.error };
  const c = current(d);
  d.available = d.available.filter((p) => p !== found.player);
  d.picks.push({ ...c, player: found.player, by: byId, auto });
  arm(d);
  save();
  return {
    message: `${auto ? '⏰ Time ran out, auto-drafted.' : '✅'} Pick ${label(c.round, c.pickInRound)} — slot ${c.slot} ${mention(d.slots[c.slot])} selects **${found.player}**\n` +
      `${d.available.length} players left.\n${onTheClock(d)}`,
  };
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.guildId) return;
    const d = get(i.guildId);

    if (i.isAutocomplete()) {
      const q = i.options.getFocused().toLowerCase();
      const hits = d.available.filter((p) => p.toLowerCase().includes(q)).slice(0, 25);
      return i.respond(hits.map((p) => ({ name: p.slice(0, 100), value: p.slice(0, 100) })));
    }
    // A drafter chose a player from one of the dropdowns.
    if (i.isStringSelectMenu() && i.customId.startsWith('pick:')) {
      if (!d.started || isDone(d) || Number(i.customId.split(':')[1]) !== d.picks.length) {
        return i.reply({ content: 'That menu is out of date. Use the newest one.', ephemeral: true });
      }
      const c = current(d);
      if (!ownsSlot(i.member, i.user.id, d.slots[c.slot])) {
        return i.reply({ content: `It's not your turn. Slot ${c.slot} is on the clock.`, ephemeral: true });
      }
      const player = d.players[Number(i.values[0])];
      if (!player || !d.available.includes(player)) {
        return i.reply({ content: 'That player is no longer available.', ephemeral: true });
      }
      const r = makePick(d, player, i.user.id);
      if (r.error) return i.reply({ content: r.error, ephemeral: true });
      const payload = clock(d, r.message);
      await i.update({ components: [] });
      return deliver(d, payload, i);
    }
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'available') {
      if (!d.available.length) return i.reply({ content: 'No players available.', ephemeral: true });
      return i.reply(chunk(`**Available (${d.available.length})**\n${d.available.join('\n')}`));
    }

    if (i.commandName === 'board') {
      if (!d.started) d.slots = rolesByName(i.guild);
      const order = Array.from({ length: SLOTS }, (_, k) => `${k + 1}. ${mention(d.slots[k + 1])}`).join('\n');
      const picks = d.picks.map((p) => `${label(p.round, p.pickInRound)} · slot ${p.slot} — ${p.player ?? '*skipped*'}`).join('\n');
      const status = d.started ? onTheClock(d) : 'Draft has not started.';
      return i.reply({
        content: chunk(`**Draft order**\n${order}\n\n**Picks**\n${picks || 'None yet.'}\n\n${status}`),
        allowedMentions: { parse: [] },
      });
    }

    if (i.commandName === 'pick') {
      if (!d.started) return i.reply({ content: 'The draft has not started yet.', ephemeral: true });
      if (isDone(d)) return i.reply({ content: 'The draft is already complete.', ephemeral: true });
      const c = current(d);
      if (!ownsSlot(i.member, i.user.id, d.slots[c.slot])) {
        return i.reply({ content: `It's not your turn. Slot ${c.slot} is on the clock.`, ephemeral: true });
      }
      const r = makePick(d, i.options.getString('player'), i.user.id);
      return r.error ? i.reply({ content: r.error, ephemeral: true }) : deliver(d, clock(d, r.message), i);
    }

    if (i.commandName !== 'draft') return;
    const sub = i.options.getSubcommand();

    if (sub === 'upload') {
      if (d.started) return i.reply({ content: 'Draft is in progress. Use `/draft reset` first.', ephemeral: true });
      const file = i.options.getAttachment('file');
      let text = i.options.getString('list') ?? '';
      if (file) {
        await i.deferReply();
        text = await (await fetch(file.url)).text();
      }
      const seen = new Set();
      const players = text.split(/[\r\n,]+/).map((p) => p.trim()).filter((p) => {
        const k = p.toLowerCase();
        if (!p || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!players.length) {
        const msg = 'No players found. Attach a file or paste a list.';
        return file ? i.editReply(msg) : i.reply({ content: msg, ephemeral: true });
      }
      d.players = players;
      d.available = [...players];
      d.picks = [];
      save();
      const msg = `📋 Loaded **${players.length}** players.`;
      return file ? i.editReply(msg) : i.reply(msg);
    }

    if (sub === 'start') {
      if (d.started && !isDone(d)) return i.reply({ content: 'Draft is already running.', ephemeral: true });
      if (!d.players.length) return i.reply({ content: 'Upload a player list first with `/draft upload`.', ephemeral: true });
      const slots = rolesByName(i.guild);
      const missing = Array.from({ length: SLOTS }, (_, k) => k + 1).filter((n) => !slots[n]);
      if (missing.length) return i.reply({ content: `Create these roles first: ${missing.map((n) => `Drafter ${n}`).join(', ')}`, ephemeral: true });
      d.slots = slots;
      const max = Math.floor(d.players.length / SLOTS);
      if (max < 1) return i.reply({ content: `You need at least ${SLOTS} players.`, ephemeral: true });
      d.rounds = Math.min(i.options.getInteger('rounds') ?? max, max);
      d.snake = i.options.getBoolean('snake') ?? false;
      d.available = [...d.players];
      d.picks = [];
      d.started = true;
      d.channelId = i.channelId;
      arm(d);
      save();
      return deliver(d, clock(d, `🏈 **Draft started!** ${d.rounds} rounds, ${d.snake ? 'snake' : 'straight'} order, ${PICK_SECONDS}s per pick, ` +
        `${d.available.length} players.\n${onTheClock(d)}`), i);
    }

    if (sub === 'reset') {
      clearTimeout(timers.get(i.guildId));
      if (lastMenu.has(i.guildId)) Promise.resolve().then(lastMenu.get(i.guildId)).catch(() => {});
      lastMenu.delete(i.guildId);
      db[i.guildId] = blank();
      save();
      return i.reply('Draft wiped.');
    }

    if (!d.started) return i.reply({ content: 'The draft has not started yet.', ephemeral: true });

    if (sub === 'undo') {
      const last = d.picks.pop();
      if (!last) return i.reply({ content: 'Nothing to undo.', ephemeral: true });
      if (last.player) {
        d.available.push(last.player);
        d.available.sort((a, b) => d.players.indexOf(a) - d.players.indexOf(b));
      }
      arm(d);
      save();
      return deliver(d, clock(d, `↩️ Undid pick ${label(last.round, last.pickInRound)} (${last.player ?? 'skip'}).\n${onTheClock(d)}`), i);
    }

    if (isDone(d)) return i.reply({ content: 'The draft is already complete.', ephemeral: true });

    if (sub === 'skip') {
      const c = current(d);
      d.picks.push({ ...c, player: null, by: i.user.id });
      arm(d);
      save();
      return deliver(d, clock(d, `⏭️ Slot ${c.slot} skipped at pick ${label(c.round, c.pickInRound)}.\n${onTheClock(d)}`), i);
    }

    if (sub === 'forcepick') {
      const r = makePick(d, i.options.getString('player'), i.user.id);
      return r.error ? i.reply({ content: r.error, ephemeral: true }) : deliver(d, clock(d, r.message), i);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (i.isRepliable?.()) (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Set the DISCORD_TOKEN environment variable first.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
