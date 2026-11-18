import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';

it.skipIf(process.platform !== 'win32')('builds the Windows native companion before qualification', () => {
  accessSync(resolve('dist/native-host/relay-native-host.exe'), constants.F_OK);
});
