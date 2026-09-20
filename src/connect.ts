import { stdin, stderr, stdout } from 'node:process';
import { connect } from './auth.js';
import { loadConfig } from './config.js';

async function readLoginUrl(): Promise<string> {
  const maxInputLength = 16_384;
  if (!stdin.isTTY) {
    let input = '';
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) {
      input += chunk;
      if (input.length > maxInputLength) throw new Error('DSH login URL input is too long');
    }
    const firstLine = input.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) throw new Error('No DSH login URL was provided on stdin');
    return firstLine;
  }

  if (!stdin.setRawMode) throw new Error('Secure terminal input is unavailable; pipe the login URL through stdin');
  stderr.write('Paste the current DSH login URL (input hidden): ');
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.setRawMode(true);
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const restore = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      process.off('SIGHUP', onSignal);
      process.off('SIGTERM', onSignal);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const finish = (error?: Error) => {
      restore();
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Connection cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') {
          value += character;
          if (value.length > maxInputLength) return finish(new Error('DSH login URL input is too long'));
        }
      }
    };
    const onEnd = () => finish(new Error('Terminal input ended before a DSH login URL was provided'));
    const onError = () => finish(new Error('Unable to read the DSH login URL'));
    const onSignal = () => finish(new Error('Connection cancelled'));
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    process.once('SIGHUP', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error('Do not pass the DSH login URL as a command-line argument; use hidden input or stdin');
  }
  const config = loadConfig();
  const loginUrl = await readLoginUrl();
  if (loginUrl === '') throw new Error('No DSH login URL was provided');
  await connect(loginUrl, config);
  stdout.write(`Connected to DSH at ${config.origin}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unable to connect to DSH';
  stderr.write(`${message}\n`);
  process.exitCode = 1;
});
