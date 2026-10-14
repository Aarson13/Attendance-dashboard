#!/usr/bin/env node
/**
 * write-samples.mjs — regenerate samples/ from the same sources the app uses, so the files people
 * download can never drift from what the app actually imports.
 *
 * Usage: npm run samples
 */
import fs from 'node:fs';
import path from 'node:path';

await import('../js/calc.js');
await import('../js/store.js');
await import('../js/manipal-calendar.js');
await import('../js/sample-data.js');

const { Store, Sample } = globalThis.AD;
const dir = path.resolve('samples');
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'calendar-sample.csv'), `${Store.SAMPLE_CALENDAR_CSV}\n`);

const today = new Date().toLocaleDateString('en-CA');
const data = Sample.build(today);
fs.writeFileSync(
  path.join(dir, 'sample-data.json'),
  `${JSON.stringify({ app: 'attendance-dashboard', version: Store.VERSION, exportedAt: new Date().toISOString(), data }, null, 2)}\n`,
);

console.log(`samples/calendar-sample.csv        (${Store.SAMPLE_CALENDAR_CSV.split('\n').length} lines)`);
console.log(`samples/sample-data.json           (${data.subjects.length} subjects, ${data.records.length} attendance records, generated for ${today})`);
