// GF-T6: typing through an input method into a backend terminal. The bytes the backend
// receives are the finished text — never the loose jamo of a syllable still being composed.
// The input method is driven the way Chrome reports one: each key it takes is a keydown 229,
// then the composition changes; a syllable commits when the next key cannot join it.
import { expect, test, type CDPSession, type Page } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:35173' });

const screen = (page: Page) => page.getByTestId('term-screen');

async function openShell(page: Page) {
  const res = await page.request.post('/api/_fake/fixture', { data: { name: 'normal' } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await page.getByTestId('terminals-toggle').click();
  await page.getByTestId('term-folder').fill('/work');
  await page.getByTestId('term-new-shell').click();
  await expect(screen(page)).toHaveAttribute('data-status', 'live');
  await screen(page).click();
}

/** Everything the panel posted as terminal input, decoded as UTF-8 in order. */
function received(page: Page) {
  const chunks: Buffer[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/input')) {
      chunks.push(Buffer.from(JSON.parse(r.postData() ?? '{}').bytesBase64, 'base64'));
    }
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

/** A Korean (2-set) input method: each step is the composition after one key; '|' commits. */
async function compose(cdp: CDPSession, steps: string[]) {
  for (const step of steps) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process' });
    const [commit, next] = step.includes('|') ? step.split('|') : [null, step];
    if (commit !== null) await cdp.send('Input.insertText', { text: commit });
    if (next) await cdp.send('Input.imeSetComposition', { text: next!, selectionStart: next!.length, selectionEnd: next!.length });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Process' });
  }
}

test('Hangul composed in the terminal reaches the backend as finished syllables', async ({ page }) => {
  await openShell(page);
  const bytes = received(page);
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.type('orbit');
  // 은 → space → 왜 → space → 이렇게 (ㄹ moves on to 러, ㄱ on to 게) → Enter.
  await compose(cdp, ['ㅇ', '으', '은', '은|']);
  await page.keyboard.press('Space');
  await compose(cdp, ['ㅇ', '오', '왜', '왜|']);
  await page.keyboard.press('Space');
  await compose(cdp, ['ㅇ', '이', '일', '이|러', '렇', '렇|ㄱ', '게', '게|']);
  await page.keyboard.press('Enter');
  await expect.poll(bytes).toBe('orbit은 왜 이렇게\r');
  await expect(screen(page).locator('.xterm-rows')).toContainText('$ orbit은 왜 이렇게');
  expect(Buffer.from(bytes(), 'utf8').equals(Buffer.from('orbit은 왜 이렇게\r', 'utf8'))).toBe(true);
});

test('Enter right after a syllable sends the syllable first', async ({ page }) => {
  await openShell(page);
  const bytes = received(page);
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, ['ㅎ', '하', '한', '한|']);
  await page.keyboard.press('Enter');
  await expect.poll(bytes).toBe('한\r');
});

test('English keys and a paste go through unchanged', async ({ page }) => {
  await openShell(page);
  const bytes = received(page);
  await page.keyboard.type('ls -la');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '붙여넣기 paste');
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Enter');
  await expect.poll(bytes).toBe('ls -la\r붙여넣기 paste\r');
  await expect(screen(page).locator('.xterm-rows')).toContainText('$ 붙여넣기 paste');
});
