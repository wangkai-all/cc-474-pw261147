import { chromium } from 'playwright-core';

/**
 * Launch headless Chromium.
 *
 * In this sandbox the browser's shared libraries and fonts are staged under
 * /tmp/libs (see README). When those are absent (a normal dev machine) we fall
 * back to the host's system libs.
 */
export async function launch() {
  const extra = process.env.EXTRA_LD_LIBRARY_PATH;
  const env = { ...process.env };
  if (extra) env.LD_LIBRARY_PATH = [extra, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if (process.env.FONTCONFIG_FILE) env.FONTCONFIG_FILE = process.env.FONTCONFIG_FILE;
  return chromium.launch({ headless: true, env });
}
