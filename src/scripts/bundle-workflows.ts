/**
 * Pre-bundles workflow code at build time (`npm run build`) so the worker does
 * not need to run webpack on every start. Output: dist/workflow-bundle.js
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

async function main(): Promise<void> {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('../temporal/workflows'),
  });
  const out = path.resolve(__dirname, '../workflow-bundle.js');
  await writeFile(out, code);
  console.log(`Workflow bundle written to ${out} (${(code.length / 1024).toFixed(1)} KiB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
