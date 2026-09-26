// Regression coverage for the batch_id 19 production incident (window=morning,
// lang=ru, date 2026-09-26) -- see this task's spec for the full trace. Covers:
//   1. req.ip / trust proxy resolves the real client IP through a realistic
//      Render-shaped X-Forwarded-For chain (src/server.js).
//   2. IP-vs-timezone location mismatch drops weather_lifehack and records
//      trace.location_mismatch (src/routes/batch.js).
//   4. No activity-based phone_trend/context_signal candidates in the
//      morning window (src/slotPlanner.js).
//   5. One real-world topic planned at most once per batch (src/slotPlanner.js).
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-incident19-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { countryForTimezone } = require('../src/timezoneCountry');
const {
  collectCandidates,
  planSlots,
  _test: plannerTest,
} = require('../src/slotPlanner');

function requestJson(server, pathName) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          return reject(err);
        }
        resolve({ statusCode: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

// --- Part 1: trust proxy / req.ip through a realistic Render-shaped chain ---
//
// Simulated topology: this test's own loopback connection stands in for
// Render's INNERMOST proxy hop (the one directly connected to our process --
// its address is the TCP socket's own remoteAddress, always 127.0.0.1/::1 in
// a local test and NOT itself present in X-Forwarded-For). The
// X-Forwarded-For header carries the two hops further out: the real client
// IP (leftmost) and a second, still-internal Render hop that (per the
// production trace) geolocates to Render's own Frankfurt datacenter.
//
// With trust proxy=1 (the pre-fix config): only the socket hop is trusted,
// so req.ip resolves to the INNER Render hop from the header -- reproducing
// the bug (an internal Render address, not the client's).
// With trust proxy=2 (the fix in src/server.js): both the socket hop and the
// header's rightmost entry are trusted, so req.ip resolves to the real
// client IP.
async function testTrustProxyHopCount() {
  const REAL_CLIENT_IP = '203.0.113.42'; // TEST-NET-3, RFC 5737 -- never a real routable address
  const RENDER_INTERNAL_HOP = '10.0.0.9'; // stand-in for a Render-internal hop (private range)
  const xffHeader = `${REAL_CLIENT_IP}, ${RENDER_INTERNAL_HOP}`;

  async function resolvedIpWithTrustProxy(trustProxyValue) {
    const app = express();
    app.set('trust proxy', trustProxyValue);
    app.get('/whoami', (req, res) => {
      res.status(200).json({ ip: req.ip });
    });
    const server = await new Promise((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const port = server.address().port;
      const body = await new Promise((resolve, reject) => {
        http.get({
          host: '127.0.0.1',
          port,
          path: '/whoami',
          headers: { 'X-Forwarded-For': xffHeader },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });
      return body.ip;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const buggyIp = await resolvedIpWithTrustProxy(1);
  assert.strictEqual(
    buggyIp,
    RENDER_INTERNAL_HOP,
    'sanity check: trust proxy=1 against a 2-hop chain reproduces the bug (lands on the internal hop, not the client)'
  );

  const fixedIp = await resolvedIpWithTrustProxy(2);
  assert.strictEqual(
    fixedIp,
    REAL_CLIENT_IP,
    'trust proxy=2 (src/server.js fix) must resolve the real client IP through a 2-hop Render-shaped X-Forwarded-For chain'
  );
}

// --- Part 2: IP-vs-timezone location mismatch ---
async function withMockedBatchRoute({ geo, weather, deviceTimezone }, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];

  let capturedBatchArgs = null;
  let capturedPackArgs = null;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: async (device, window, signals, weatherArg, phoneTrends, options) => {
          capturedBatchArgs = { device, window, signals, weather: weatherArg, phoneTrends, options };
          return {
            phrases: [],
            source: 'ai',
            context: null,
            trace: { meta: {}, planned: [], final: [] },
          };
        },
        resolveLocalDateContext: require('../src/contentGenerator').resolveLocalDateContext,
      };
    }
    if (request === '../weather') {
      return {
        resolveGeolocation: async () => geo,
        resolveWeather: async () => weather,
      };
    }
    if (request === '../morningPack') {
      return {
        getOrGenerateMorningPack: async (args) => {
          capturedPackArgs = args;
          return null;
        },
      };
    }
    if (request === '../adminMessages') {
      return { consumePendingMessages: () => [] };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let server;
  try {
    const app = express();
    app.use('/api/v1', require('../src/routes/batch'));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: 'internal server error' });
    });
    server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    if (deviceTimezone) {
      db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone) VALUES (?, ?)')
        .run('incident19-device', deviceTimezone);
    }
    return await callback(server, () => ({ batch: capturedBatchArgs, pack: capturedPackArgs }));
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function testLocationMismatchDropsWeatherAndRecordsTrace() {
  // Astana, Kazakhstan phone timezone (tz_country = KZ), but IP geolocation
  // resolves to Germany (ip_country = DE) -- the exact shape of the batch_id
  // 19 incident (Render's own Frankfurt hosting region leaking through).
  await withMockedBatchRoute({
    geo: { success: true, country_code: 'DE', city: 'Frankfurt am Main', latitude: 50.1109, longitude: 8.6821 },
    weather: { countryCode: 'DE', city: 'Frankfurt am Main', temperatureC: 11, description: 'clear' },
    deviceTimezone: 'Asia/Almaty',
  }, async (server, getCaptured) => {
    const { json } = await requestJson(
      server,
      '/api/v1/batch?device_id=incident19-device&window=morning&timezone=Asia%2FAlmaty&supports_morning_pack=1'
    );
    assert.strictEqual(json.batch_id !== undefined, true, 'response should still succeed normally');

    const { batch, pack } = getCaptured();
    assert(batch, 'generateBatch must have been called');
    assert.strictEqual(
      typeof batch.weather.temperatureC,
      'undefined',
      'weather passed to generateBatch must NOT carry IP-based temperature on a location mismatch (weather_lifehack must be droppable)'
    );
    assert.strictEqual(
      batch.weather.countryCode,
      'KZ',
      'country used for content purposes must be the TIMEZONE country (KZ), not the IP country (DE)'
    );
    assert.strictEqual(pack.geo, null, 'the morning pack must also be told to skip its own IP-based weather forecast on a mismatch');

    const row = db.prepare('SELECT trace_json FROM content_batches WHERE id = ?').get(json.batch_id);
    assert(row && row.trace_json, 'a trace row must have been stored');
    const trace = JSON.parse(row.trace_json);
    assert.deepStrictEqual(
      trace.location_mismatch,
      { ip_country: 'DE', tz_country: 'KZ' },
      'trace.location_mismatch must record both the IP-resolved and timezone-resolved countries'
    );
  });
}

async function testMatchingLocationIsUnaffected() {
  // IP resolves to KZ, timezone is also KZ -- no mismatch, everything works
  // exactly as before: weather present, no location_mismatch field at all.
  await withMockedBatchRoute({
    geo: { success: true, country_code: 'KZ', city: 'Astana', latitude: 51.1801, longitude: 71.446 },
    weather: { countryCode: 'KZ', city: 'Astana', temperatureC: -2, description: 'clear' },
    deviceTimezone: 'Asia/Almaty',
  }, async (server, getCaptured) => {
    const { json } = await requestJson(
      server,
      '/api/v1/batch?device_id=incident19-device&window=morning&timezone=Asia%2FAlmaty&supports_morning_pack=1'
    );
    assert.strictEqual(json.batch_id !== undefined, true);

    const { batch, pack } = getCaptured();
    assert.strictEqual(batch.weather.temperatureC, -2, 'matching case: real IP-based weather must still be used');
    assert.strictEqual(batch.weather.countryCode, 'KZ');
    assert.notStrictEqual(pack.geo, null, 'matching case: the pack must still get real geo for its own forecast');

    const row = db.prepare('SELECT trace_json FROM content_batches WHERE id = ?').get(json.batch_id);
    const trace = JSON.parse(row.trace_json);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(trace, 'location_mismatch'),
      false,
      'matching case: trace must NOT carry a location_mismatch field at all'
    );
  });
}

// --- Part 4: no activity-based signals in the morning window ---
function testNoActivitySignalsInMorning() {
  const baseInput = {
    device: { device_id: 'signal-device', name: 'Nurlan' },
    dateContext: { date: '2026-09-26', weekday: 'Saturday', time: '07:30' },
    weather: null,
    bankItems: [],
    signals: { unlocks_since_last_batch: 45 }, // > MANY_UNLOCKS_THRESHOLD (30)
    phoneTrends: { unlocks_vs_yesterday: 'higher', steps_vs_yesterday: 'lower' },
  };

  // Filtering happens in planSlots (which excludes disallowed-in-window
  // candidates before ranking) -- planSlots returns the post-filter
  // candidate pool alongside the final slots, so both are checked below.
  for (const window of ['morning']) {
    const { candidates, slots } = planSlots({ ...baseInput, window }, { seed: `incident19-${window}-seed` });
    assert(
      !candidates.some((c) => c.type === 'phone_trend'),
      `${window}: phone_trend candidate must never be in the candidate pool (activity accumulated so far today is meaningless first thing in the morning)`
    );
    assert(
      !candidates.some((c) => c.type === 'context_signal' && c.facts.signal === 'many_unlocks'),
      `${window}: context_signal/many_unlocks candidate must never be in the candidate pool (activity-based)`
    );
    assert(
      !slots.some((s) => s.type === 'phone_trend' || (s.type === 'context_signal' && s.facts.signal === 'many_unlocks')),
      `${window}: no activity-based signal slot may be planned`
    );
  }

  // Control: the exact same underlying signals DO still produce these
  // candidates in a non-morning window.
  for (const window of ['day', 'evening', 'night']) {
    const { candidates } = planSlots({ ...baseInput, window }, { seed: `incident19-${window}-seed` });
    assert(
      candidates.some((c) => c.type === 'phone_trend'),
      `${window}: phone_trend candidate should still be in the pool outside the morning window`
    );
    assert(
      candidates.some((c) => c.type === 'context_signal' && c.facts.signal === 'many_unlocks'),
      `${window}: context_signal/many_unlocks candidate should still be in the pool outside the morning window`
    );
  }

  // A non-activity-based context_signal variant (low_battery) must still be
  // allowed in the morning.
  const lowBatteryInput = {
    ...baseInput,
    window: 'morning',
    signals: { battery_level: 8 },
    phoneTrends: {},
  };
  const { candidates: lowBatteryCandidates } = planSlots(lowBatteryInput, { seed: 'incident19-low-battery-seed' });
  assert(
    lowBatteryCandidates.some((c) => c.type === 'context_signal' && c.facts.signal === 'low_battery'),
    'morning: a non-activity-based context_signal (low_battery) must still be allowed'
  );

  // End-to-end through planSlots too, with signals strong enough that the
  // lottery would otherwise be very likely to pick them.
  const plan = planSlots({ ...baseInput, window: 'morning' }, { seed: 'incident19-morning-seed' });
  assert(
    !plan.slots.some((s) => s.type === 'phone_trend' || (s.type === 'context_signal' && s.facts.signal === 'many_unlocks')),
    'planSlots: a full morning plan must never include an activity-based phone_trend/context_signal slot'
  );
}

// --- Part 5: one real-world topic, once per batch ---
function testDuplicateTopicDetection() {
  // Reconstructed/approximated trace-19 pair: a `holiday` bank item and a
  // `country_fact` bank item both describing the same real-world event
  // (European Day of Languages), worded differently.
  const holidayText = 'European Day of Languages is celebrated today across Europe.';
  const countryFactText = 'The European Union marks European Day of Languages today.';
  assert.strictEqual(
    plannerTest.isSameTopicText(holidayText, countryFactText),
    true,
    'the trace-19-shaped holiday/country_fact pair must be detected as the same topic'
  );

  // Genuinely different Daily Bank items -- must NOT be flagged.
  const octopusFact = 'Octopuses have three hearts and blue blood.';
  const bridgeFact = 'The Golden Gate Bridge opened to traffic in 1937 after four years of construction.';
  assert.strictEqual(
    plannerTest.isSameTopicText(octopusFact, bridgeFact),
    false,
    'two genuinely unrelated Daily Bank items must not be flagged as duplicate topics'
  );

  // End-to-end: collectCandidates must plan only ONE of the trace-19 pair.
  const candidates = collectCandidates({
    device: { device_id: 'topic-device' },
    window: 'day',
    dateContext: { date: '2026-09-26', weekday: 'Saturday', time: '12:00' },
    weather: null,
    bankItems: [
      { category: 'holiday', content_text: holidayText, tags: ['global'] },
      { category: 'country_fact', content_text: countryFactText, tags: ['global'] },
      { category: 'science', content_text: octopusFact, tags: ['global'] },
    ],
  });
  const bankDerived = candidates.filter((c) => c.source === 'daily_bank');
  assert.strictEqual(bankDerived.length, 2, 'only one of the duplicate-topic pair should survive, alongside the unrelated science fact');
  const survivingTexts = bankDerived.map((c) => c.facts.text);
  assert(survivingTexts.includes(holidayText) || survivingTexts.includes(countryFactText), 'one of the duplicate pair must survive');
  assert(!(survivingTexts.includes(holidayText) && survivingTexts.includes(countryFactText)), 'both of the duplicate pair must never survive together');
  assert(survivingTexts.includes(octopusFact), 'the unrelated fact must always survive');

  // Two genuinely different bank items must both survive.
  const candidates2 = collectCandidates({
    device: { device_id: 'topic-device-2' },
    window: 'day',
    dateContext: { date: '2026-09-26', weekday: 'Saturday', time: '12:00' },
    weather: null,
    bankItems: [
      { category: 'science', content_text: octopusFact, tags: ['global'] },
      { category: 'on_this_day', content_text: bridgeFact, tags: ['global'] },
    ],
  });
  const bankDerived2 = candidates2.filter((c) => c.source === 'daily_bank').map((c) => c.facts.text);
  assert(bankDerived2.includes(octopusFact) && bankDerived2.includes(bridgeFact), 'two genuinely different bank items must both survive');
}

// Sanity check on the tz->country table used by Part 2.
function testTimezoneCountryLookup() {
  const kazakhstanTimezones = [
    'Asia/Almaty',
    'Asia/Qostanay',
    'Asia/Aqtobe',
    'Asia/Aqtau',
    'Asia/Atyrau',
    'Asia/Oral',
    'Asia/Qyzylorda',
  ];
  for (const timezone of kazakhstanTimezones) {
    assert.strictEqual(countryForTimezone(timezone), 'KZ', `${timezone} must resolve to Kazakhstan`);
  }
  assert.strictEqual(countryForTimezone('Europe/Berlin'), 'DE');
  assert.strictEqual(countryForTimezone('Not/AZone'), 'unknown');
  assert.strictEqual(countryForTimezone(null), 'unknown');
}

async function main() {
  testTimezoneCountryLookup();
  testNoActivitySignalsInMorning();
  testDuplicateTopicDetection();
  await testTrustProxyHopCount();
  await testLocationMismatchDropsWeatherAndRecordsTrace();
  await testMatchingLocationIsUnaffected();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  })
  .catch((err) => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // best effort cleanup
    }
    console.error(err);
    process.exit(1);
  });
