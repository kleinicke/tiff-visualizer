import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test.skip(!process.env.IMAGE_VIEWER_PYTHON, 'Set IMAGE_VIEWER_PYTHON to an interpreter with the arrays extra installed');

test('Python session inspects original NumPy pixels, applies display settings and captures the real viewer', async ({ page }) => {
  const python = spawn(process.env.IMAGE_VIEWER_PYTHON || 'python3', ['packages/python/tests/browser_host.py'], { stdio: ['pipe','pipe','pipe'] });
  const lines = createInterface({input:python.stdout});
  let pending: ((value: any) => void) | undefined;
  let stderr = '';
  python.stderr.on('data',data=>stderr+=data);
  lines.on('line',line=>{pending?.(JSON.parse(line));pending=undefined;});
  const call = (operation: string,args={}) => new Promise<any>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`Python ${operation} timed out: ${stderr}`)),30000);
    pending=value=>{clearTimeout(timeout);if(value.error)reject(new Error(value.error));else resolve(value.result);};
    python.stdin.write(JSON.stringify({operation,args})+'\n');
  });
  try {
    const status=await call('open');
    expect(status.connection).toBe('awaiting_renderer');
    await page.goto(status.url);
    const image=await call('inspect');
    expect([image.width,image.height,image.channels]).toEqual([4,3,1]);
    expect((await call('pixel',{x:2,y:1})).values).toEqual([6]);
    const before=await call('capture');
    expect(Buffer.from(before.png,'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    const updated=await call('set_display',{value_range:[0,22]});
    expect(updated.settings.normalization.max).toBe(22);
    expect((await call('pixel',{x:2,y:1})).values).toEqual([6]);
    expect((await call('capture')).png).not.toBe(before.png);
    const region=await call('measure_region',{x:0,y:0,width:2,height:2});
    expect(region.rows[0].area).toBe(4);
    expect(region.rows[0].mean).toBe(2.5);
    expect((await call('measurements')).rois).toHaveLength(1);
    await expect(call('pixel',{x:100,y:0})).rejects.toThrow(/outside/);
    await call('update_array');
    const next=await call('inspect');
    expect([next.width,next.height,next.channels]).toEqual([3,2,3]);
    expect((await call('pixel',{x:1,y:1})).values).toEqual([42,42,42]);
  } finally { python.stdin.end(); lines.close(); python.kill(); }
});
