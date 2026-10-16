/** Loads .env files before any other module reads process.env (imported first by index.ts). */
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // optional
  }
}
