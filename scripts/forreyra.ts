/**
 * Forreyra — command-line browser.
 *
 * One command to drive a real browser without writing any code:
 *
 *   npx tsx scripts/forreyra.ts https://example.com
 *   npx tsx scripts/forreyra.ts https://news.ycombinator.com extract:Apple
 *   npx tsx scripts/forreyra.ts https://duckduckgo.com type:1=playwright press:Enter
 *
 * Actions run left to right against one open page:
 *   click:<index>          click element [index] from the last view
 *   type:<index>=<text>    type text into element [index]
 *   press:<key>            press a key (Enter, Tab, Escape, ...)
 *   scroll:up | scroll:down
 *   extract[:<pattern>]    print the page text (optionally only matching sentences)
 *   view                   re-print the element list
 */
import { BrowserService, type BrowserSnapshot } from '../src/services/browser.ts';
import { renderQueryResult } from '../src/services/query.ts';

const USAGE = `Forreyra — a real browser on the command line.

Usage:
  npx tsx scripts/forreyra.ts <url> [action ...]

Actions (run in order):
  click:<n>            click element [n]
  type:<n>=<text>      type into element [n]
  press:<key>          press a key, e.g. press:Enter
  scroll:up|down       scroll one screen
  extract[:<regex>]    print page text (optionally matching sentences)
  query:<question>     answer a plain-English question, e.g. query:what is the price
  view                 re-print the elements

Examples:
  npx tsx scripts/forreyra.ts https://example.com
  npx tsx scripts/forreyra.ts https://news.ycombinator.com extract:Apple
  npx tsx scripts/forreyra.ts https://duckduckgo.com type:1=playwright press:Enter
`;

function showElements(snap: BrowserSnapshot): void {
  console.log(`url:   ${snap.url}`);
  console.log(`title: ${snap.title}`);
  console.log('elements:');
  for (const e of snap.elements) {
    console.log(`  [${e.i}] ${e.tag}${e.type ? `(${e.type})` : ''} ${e.text}${e.href ? ` -> ${e.href}` : ''}`.trimEnd());
  }
}

async function main(): Promise<void> {
  const [url, ...actions] = process.argv.slice(2);
  if (!url || url === '-h' || url === '--help') {
    console.log(USAGE);
    process.exit(url ? 0 : 1);
  }

  const browser = new BrowserService();
  try {
    let snap = await browser.open(url);
    showElements(snap);

    for (const action of actions) {
      const [verb, rest] = action.split(/:(.*)/s);
      if (verb === 'click') {
        snap = await browser.click(Number(rest));
      } else if (verb === 'type') {
        const [idx, text] = (rest ?? '').split(/=(.*)/s);
        snap = await browser.type(Number(idx), text ?? '');
      } else if (verb === 'press') {
        snap = await browser.press(rest || 'Enter');
      } else if (verb === 'scroll') {
        snap = await browser.scroll(rest === 'up' ? 'up' : 'down');
      } else if (verb === 'extract') {
        console.log('\n--- extract ---');
        console.log(await browser.extract(rest || undefined));
        continue;
      } else if (verb === 'query') {
        console.log('\n--- query ---');
        console.log(renderQueryResult(await browser.query(rest || '')));
        continue;
      } else if (verb === 'view') {
        snap = await browser.view();
      } else {
        console.error(`Unknown action: ${action}`);
        continue;
      }
      console.log(`\n--- after ${action} ---`);
      showElements(snap);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`Forreyra failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
