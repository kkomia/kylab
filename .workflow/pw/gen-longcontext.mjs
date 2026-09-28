// Generates the 31-turn long-context scenario.
import fs from 'node:fs';
const SEL = 'textarea[aria-label="消息输入框"]';
const STOP = 'button[aria-label="停止生成"]';
const steps = [
  { kind: 'ensureLogin', username: 'kkomia', password: '117118363' },
  { kind: 'goto', url: '/chat', settle: 3000 },
  { kind: 'clickText', value: '新建会话', settle: 2500 },
  { kind: 'note', value: 'turn 1: plant an early fact' },
  { kind: 'fill', selector: SEL, value: '请记住这个口令：ZQ7K-凌云。只回复「记住了」三个字。' },
  { kind: 'press', selector: SEL, key: 'Enter', settle: 2000 },
  { kind: 'waitFor', selector: STOP, state: 'detached', timeout: 120000 },
];
for (let i = 2; i <= 30; i++) {
  steps.push({ kind: 'fill', selector: SEL, value: `请只输出这几个字符，不要任何其它内容：FILLER-${i}` });
  steps.push({ kind: 'press', selector: SEL, key: 'Enter', settle: 1500 });
  steps.push({ kind: 'waitFor', selector: STOP, state: 'detached', timeout: 120000 });
}
steps.push({ kind: 'note', value: 'after 30 turns: recall the early fact + inspect context' });
steps.push({ kind: 'eval', code: 'JSON.stringify({turns:document.querySelectorAll(\'[data-role="assistant"]\').length})' });
steps.push({ kind: 'fill', selector: SEL, value: '我最开始让你记住的那个口令是什么？只回答口令本身，不要解释。' });
steps.push({ kind: 'press', selector: SEL, key: 'Enter', settle: 2000 });
steps.push({ kind: 'waitFor', selector: STOP, state: 'detached', timeout: 120000 });
steps.push({ kind: 'wait', ms: 1500 });
steps.push({ kind: 'shot', path: '190-longcontext-31turns.png' });
steps.push({ kind: 'eval', code: '(() => { const ms=[...document.querySelectorAll(\'[data-role="assistant"]\')]; return JSON.stringify({turns:ms.length, first:ms[0].innerText.slice(0,120), last:ms[ms.length-1].innerText.slice(0,300)}); })()' });
steps.push({ kind: 'click', selector: 'button[aria-label="选择对话模型"]', settle: 1500 });
steps.push({ kind: 'shot', path: '191-longcontext-usage.png' });
steps.push({ kind: 'eval', code: '(() => { const m=[...document.querySelectorAll(\'[role="menu"]\')]; return JSON.stringify({menu:m.map(e=>e.innerText.replace(/\\n/g,\' | \').slice(0,700)).join(\' /// \')}); })()' });
steps.push({ kind: 'press', key: 'Escape', settle: 600 });
steps.push({ kind: 'eval', code: 'JSON.stringify({kinds:[...new Set([...document.querySelectorAll(\'[data-kind]\')].map(e=>e.getAttribute(\'data-kind\')))]})' });

const cfg = {
  baseUrl: 'http://localhost:5173',
  headless: true,
  viewport: { width: 1440, height: 900 },
  shotDir: 'D:/GitLab/kylab/docs/产品走查-2026-09-28/shots',
  userDataDir: 'D:/GitLab/kylab/.workflow/pw/.pwprofile',
  timeout: 15000,
  steps,
};
fs.writeFileSync('D:/GitLab/kylab/.workflow/pw/s26-longcontext.json', JSON.stringify(cfg, null, 1), 'utf8');
console.log('steps=' + steps.length);
