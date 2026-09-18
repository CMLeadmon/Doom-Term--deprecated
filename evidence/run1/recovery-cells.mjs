import { existsSync, writeFileSync } from 'node:fs';
const [begin, end, prefixFile, releaseFile, splitFile] = process.argv.slice(2);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
process.stdout.write(begin + '\n');
let i = 0;
for (; i < 500; i++) { process.stdout.write('CELL_' + String(i).padStart(3, '0') + '\n'); await pause(5); }
writeFileSync(prefixFile, '');
while (!existsSync(releaseFile)) await pause(10);
process.stdout.write('BOUNDARY_READY\n');
process.stdout.write('\x1b[1;3');
writeFileSync(splitFile, '');
await pause(800);
process.stdout.write('1mSTYLE_中文\x1b[0m\n');
process.stdout.write('CURSOR_ABCD\rCURSOR_X\n');
for (; i < 510; i++) { process.stdout.write('CELL_' + String(i).padStart(3, '0') + '\n'); await pause(5); }
process.stdout.write(end + '\n');
