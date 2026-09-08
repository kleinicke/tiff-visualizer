/** Private loopback session transport. Inert on the public website and in IDEs. */
type Command = { id: string; operation: string; arguments: Record<string, any> };
export function installPythonHost(host: {
  open: (files: File[]) => Promise<void>;
  execute: (operation: string, args: Record<string, any>) => Promise<unknown>;
}) {
  if (new URLSearchParams(location.search).get('host') !== 'python' || location.hostname !== '127.0.0.1') return;
  const renderer = crypto.randomUUID();
  let stopped = false, revision = 0, lastId = '';
  let reply: Record<string, unknown> | null = null;
  window.addEventListener('pagehide', () => { stopped = true; });
  const json = async (path: string, options?: RequestInit) => {
    const response = await fetch(new URL(path, location.href), { ...options, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Session host returned HTTP ${response.status}`);
    return response.json();
  };
  const poll = async () => {
    if (stopped) return;
    try {
      if (reply) {
        await json('agent/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value) });
        reply = null;
      }
      const state = await json(`agent/command?renderer_id=${renderer}`);
      if (!state.busy) {
        const manifest = await json('session.json');
        if (manifest.revision !== revision) {
          const files: File[] = [];
          for (const entry of manifest.files) {
            const response = await fetch(new URL(entry.url, location.href));
            if (!response.ok) throw new Error(`Cannot read ${entry.name}: HTTP ${response.status}`);
            files.push(new File([await response.blob()], entry.name));
          }
          await host.open(files);
          revision = manifest.revision;
        }
        const command = state.command as Command | null;
        if (command && command.id !== lastId) {
          lastId = command.id;
          try { reply = { id: command.id, renderer_id: renderer, result: await host.execute(command.operation, command.arguments) }; }
          catch (error) { reply = { id: command.id, renderer_id: renderer, error: error instanceof Error ? error.message : String(error) }; }
        }
      }
    } catch (error) {
      // Connection loss is recoverable; never re-execute an acknowledged mutation.
      console.debug('[Python host]', error instanceof Error ? error.message : String(error));
    } finally { if (!stopped) setTimeout(poll, 150); }
  };
  void poll();
}
