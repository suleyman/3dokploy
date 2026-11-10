/**
 * Gate for the polling rounds: while the 3Dokploy server doesn't answer (it is restarting during
 * its own redeploy, and the proxy in front answers 404), a round would fire a dozen requests at
 * different paths, which fail2ban/CrowdSec read as a scan and ban the viewer. So each round
 * first probes one fixed path; on failure it waits 5 s, 10 s, 20 s, then every 30 s.
 */
export class Backoff {
  private until = 0;
  private fails = 0;

  allowed(now: number) {
    return now >= this.until;
  }

  ok() {
    this.fails = 0;
    this.until = 0;
  }

  fail(now: number) {
    this.fails++;
    this.until = now + Math.min(30_000, 5_000 * 2 ** (this.fails - 1));
  }

  get failing() {
    return this.fails > 0;
  }
}
