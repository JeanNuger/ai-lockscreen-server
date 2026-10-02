// Local cost/length comparison of three prompt setups, against the real OpenAI API with the key
// from the local .env (never printed). Nothing here touches the working database: every step uses
// throw-away SQLite files in the OS temp directory.
//
//   A  OPENAI_REASONING_EFFORT=low      current prompts
//   B  OPENAI_REASONING_EFFORT=minimal  current prompts
//   C  OPENAI_REASONING_EFFORT=minimal  CHEAPER_PROMPT=1 (new batch prompt AND new bank prompt)
//
// Test profile: Баур, male, Aquarius, Астана, Russian. Windows: morning, day, evening, night.
// Each variant runs every window twice. A and B read a bank written once by the current bank
// prompt, C a bank written once by the new bank prompt.
//
//   node scripts/prompt-test.js [outDir]        (default outDir: C:\reports)
//
// Writes <outDir>/prompt_test_<date>.md (a table per window, all phrases in full) and
// <outDir>/prompt_test_<date>.json, and prints the summary table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OUT_DIR = process.argv[2] || 'C:\\reports';
const WINDOWS = ['morning', 'day', 'evening', 'night'];
const RUNS = 2;
const PRICE_IN_PER_M = 0.25;
const PRICE_OUT_PER_M = 2;
const BATCHES_PER_USER_PER_MONTH = 4 * 30;
const CHILD = path.join(__dirname, 'prompt-test-child.js');

const VARIANTS = {
  A: { label: 'A: low + current prompt', env: { OPENAI_REASONING_EFFORT: 'low' }, bank: 'old' },
  B: { label: 'B: minimal + current prompt', env: { OPENAI_REASONING_EFFORT: 'minimal' }, bank: 'old' },
  C: { label: 'C: minimal + new prompt', env: { OPENAI_REASONING_EFFORT: 'minimal', CHEAPER_PROMPT: '1' }, bank: 'new' },
};

function child(args, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    delete env.DATABASE_PATH;
    if (!extraEnv.CHEAPER_PROMPT) delete env.CHEAPER_PROMPT;
    const p = spawn(process.execPath, [CHILD, ...args], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

function cost(usage) {
  const input = usage.reduce((s, u) => s + u.prompt, 0);
  const output = usage.reduce((s, u) => s + u.completion, 0);
  const reasoning = usage.reduce((s, u) => s + u.reasoning, 0);
  return { input, output, reasoning, usd: (input * PRICE_IN_PER_M + output * PRICE_OUT_PER_M) / 1e6 };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
  const banks = { old: path.join(tmp, 'bank-old.db'), new: path.join(tmp, 'bank-new.db') };

  console.log('Building the two banks (one web-search call each)...');
  const [bankOld, bankNew] = await Promise.all([
    child(['bank', banks.old], {}),
    child(['bank', banks.new], { CHEAPER_PROMPT: '1' }),
  ]);
  if (bankOld.out.includes('NO_OPENAI_KEY') || bankNew.out.includes('NO_OPENAI_KEY')) {
    console.error('There is no OPENAI_API_KEY in the local .env: stopping.');
    process.exit(2);
  }
  console.log(`bank old: ${bankOld.out.split('\n').pop()}`);
  console.log(`bank new: ${bankNew.out.split('\n').pop()}`);
  if (bankOld.code !== 0 || bankNew.code !== 0) {
    console.error('A bank could not be built; see the messages above.');
    process.exit(1);
  }

  const results = {};
  for (const [name, variant] of Object.entries(VARIANTS)) {
    results[name] = [];
    for (let run = 1; run <= RUNS; run++) {
      const batch = await Promise.all(WINDOWS.map(async (window) => {
        const outFile = path.join(tmp, `${name}-${run}-${window}.json`);
        const r = await child(['run', banks[variant.bank], outFile, window], variant.env);
        if (r.code !== 0 || !fs.existsSync(outFile)) {
          return { window, run, error: r.out.slice(-600) };
        }
        return { run, ...JSON.parse(fs.readFileSync(outFile, 'utf8')) };
      }));
      results[name].push(...batch);
      console.log(`variant ${name} run ${run}: done`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `prompt_test_${today}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const summary = summarize(results);
  fs.writeFileSync(path.join(OUT_DIR, `prompt_test_${today}.md`), buildMarkdown(results, summary, today));
  console.log(summary.text);
  console.log(`report: ${path.join(OUT_DIR, `prompt_test_${today}.md`)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function summarize(results) {
  const rows = [];
  for (const [name, runs] of Object.entries(results)) {
    const ok = runs.filter((r) => !r.error);
    const usage = ok.map((r) => cost(r.usage));
    const n = ok.length || 1;
    const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
    const avgUsd = usage.reduce((s, u) => s + u.usd, 0) / n;
    rows.push({
      name,
      batches: ok.length,
      errors: runs.length - ok.length,
      input: Math.round(usage.reduce((s, u) => s + u.input, 0) / n),
      output: Math.round(usage.reduce((s, u) => s + u.output, 0) / n),
      reasoning: Math.round(usage.reduce((s, u) => s + u.reasoning, 0) / n),
      tooLong: sum((r) => r.tooLongFirstPass),
      repairs: sum((r) => r.repairRequests),
      dropped: sum((r) => r.dropped),
      usdBatch: avgUsd,
      usdMonth: avgUsd * BATCHES_PER_USER_PER_MONTH,
    });
  }
  const header = '| variant | batches | in tokens | out tokens | of them reasoning | phrases >70 (first pass) | repair requests | dropped | $ per batch | $ per user per month |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((r) => `| ${VARIANTS[r.name].label} | ${r.batches}${r.errors ? ` (+${r.errors} failed)` : ''} | ${r.input} | ${r.output} | ${r.reasoning} | ${r.tooLong} | ${r.repairs} | ${r.dropped} | ${r.usdBatch.toFixed(4)} | ${r.usdMonth.toFixed(2)} |`);
  return { rows, text: [header, sep, ...lines].join('\n') };
}

function perWindowTable(results, window, run) {
  const pick = (name) => results[name].find((r) => r.window === window && r.run === run && !r.error);
  const a = pick('A'); const b = pick('B'); const c = pick('C');
  const positions = new Set();
  for (const r of [a, b, c]) if (r) r.final.forEach((f) => positions.add(f.position));
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const cell = (r, p) => {
    const f = r && r.final.find((x) => x.position === p);
    return f ? `${esc(f.text)} (${[...f.text].length})${f.final_source === 'openai_repair' ? ' [repair]' : ''}` : '—';
  };
  const typeOf = (p) => {
    for (const r of [a, b, c]) {
      const f = r && r.final.find((x) => x.position === p);
      if (f) return f.type;
    }
    return '';
  };
  const rows = [...positions].sort((x, y) => x - y).map((p) => `| ${p}. ${typeOf(p)} | ${cell(a, p)} | ${cell(b, p)} | ${cell(c, p)} |`);
  return ['| slot | A (low, current) | B (minimal, current) | C (minimal, new prompt) |', '|---|---|---|---|', ...rows].join('\n');
}

function buildMarkdown(results, summary, today) {
  const parts = [`# Prompt test ${today}`, '', 'Profile: Баур, male, Aquarius, Астана, Russian. Texts in full; the number in brackets is the length in characters, [repair] marks a phrase rewritten by a repair request.', '', '## Summary', '', summary.text, ''];
  for (const run of [1, 2]) {
    for (const window of WINDOWS) {
      parts.push(`## ${window} (run ${run})`, '', perWindowTable(results, window, run), '');
    }
  }
  const errors = Object.entries(results).flatMap(([name, runs]) => runs.filter((r) => r.error).map((r) => `- ${name} run ${r.run} ${r.window}: ${r.error}`));
  if (errors.length) parts.push('## Failed runs', '', ...errors, '');
  return parts.join('\n');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
