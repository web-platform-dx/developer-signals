import { writeFile } from "node:fs/promises";
import { features } from "web-features";
import bcd from "@mdn/browser-compat-data" with { type: 'json' };

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const dryRun = process.argv.includes("--dry-run");

// A special comment in the issue body is used to store the web-features
// ID, <!-- web-features:some-feature -->. Whitespace is allowed wherever
// possible to make the matching less brittle to changes.
const pattern = /<!--\s*web-features\s*:\s*([a-z0-9-]+)\s*-->/;

// Features with negative standards positions are very unlikely to ever progress
// to Baseline, and we made a decision not to collect dev signals about them
// here on this repo. If any of the features we iterate on in this script has a
// standards position that matches the below strings, we skip the feature. Note
// that Mozilla uses "negative" while WebKit uses "oppose".
//
// TODO: Migrate to https://github.com/web-platform-dx/web-features-mappings/
// once that is published to NPM.
const postitionsUrl =
  "https://raw.githubusercontent.com/web-platform-dx/web-features-explorer/refs/heads/main/additional-data/standard-positions.json";
const positionsToIgnore = ["negative", "oppose"];

async function* iterateIssues(octokit, params) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      ...params,
      labels: ["feature"],
      per_page: 100,
    },
  )) {
    for (const issue of response.data) {
      yield issue;
    }
  }
}

function issueBody(id, data) {
  return `${data.description_html}

If you're a web developer and want this feature to be available in all browsers, please give this issue a thumbs up 👍!

For more details on this feature:

${data.caniuse ? `- [caniuse.com](https://caniuse.com/${data.caniuse})` : ""}
- [web features explorer](https://web-platform-dx.github.io/web-features-explorer/features/${id})
- [webstatus.dev](https://webstatus.dev/features/${id})
- [Specification](${data.spec})

<!-- web-features:${id} -->`;
}

// Get a map of features to skip with a reason for logging.
async function getFeaturesToSkip(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const resp = await fetch(postitionsUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${postitionsUrl}: ${resp.statusText}`);
  }

  const featurePositions = await resp.json();
  for (const [feature, vendorPositions] of Object.entries(featurePositions)) {
    let reason;
    for (const { position, url } of Object.values(vendorPositions)) {
      if (positionsToIgnore.includes(position)) {
        const message = `${position} position at ${url}`;
        if (reason) {
          reason = `${reason}; ${message}`;
        } else {
          reason = message;
        }
      }
    }
    if (reason) {
      map.set(feature, reason);
    }
  }

  return map;
}

async function update() {
  const skipFeatures = await getFeaturesToSkip();

  const ThrottlingOctokit = Octokit.plugin(throttling);

  // Based on https://github.com/octokit/plugin-throttling.js/blob/main/README.md
  const octokit = new ThrottlingOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`,
        );

        if (retryCount < 1) {
          // only retries once
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        // does not retry, only logs a warning
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
        );
      },
    },
  });

  const params = {
    owner: "web-platform-dx",
    repo: "developer-signals",
  };

  // Build up a manifest mapping ID to issue.
  const manifest = new Map<string, object>();

  // Iterate existing issues and create a map from web-features ID to
  // the issue. This is in order to not create duplicate issues.
  const openIssues = new Map<string, any>();
  for await (const issue of iterateIssues(octokit, params)) {
    const m = pattern.exec(issue.body);
    if (m) {
      const id = m[1];
      if (openIssues.has(id)) {
        throw new Error(`Multiple issues for ${id}: ${openIssues.get(id).html_url} and ${issue.html_url}`);
      }
      openIssues.set(id, issue);
    }
  }

  // Sort features by earliest release date in any browser, using subsequent shipping
  // dates as tie breakers. Features that aren't shipped in any browser come last.
  const sortKeys = new Map<string, string>();
  for (const [id, data] of Object.entries(features)) {
    const dates: string[] = [];
    for (const [browser, version] of Object.entries(data.status.support)) {
      const date = bcd.browsers[browser].releases[version.replace('≤', '')]?.release_date;
      if (date) {
        dates.push(date);
      }
    }
    // Add a date-like string that will sort after any real date as a tiebreaker
    // when N dates are the same and one feature has more than N dates. This
    // also ensures that features that aren't shipped sort last.
    dates.push('9999-99-99');
    dates.sort();
    sortKeys.set(id, dates.join('+'));
  }
  const sortedIds = Object.keys(features).sort((a, b) => {
    return sortKeys.get(a).localeCompare(sortKeys.get(b));
  });

  for (const id of sortedIds) {
    const data = features[id];

    if (!data) {
      console.log(`Skipping ${id}. Reason: not in web-features`);
      continue;
    }

    const skipReason = skipFeatures.get(id);
    if (skipReason) {
      console.log(`Skipping ${id}. Reason: ${skipReason}`);
      continue;
    }

    if (data.discouraged) {
      console.log(`Skipping ${id}. Reason: Discouraged according to ${data.discouraged.according_to[0]}`);
      continue;
    }

    if (data.status.baseline) {
      console.log(`Skipping ${id}. Reason: Baseline since ${data.status.baseline_low_date}`);
      continue;
    }

    const title = data.name;
    const body = issueBody(id, data);

    const issue = openIssues.get(id);
    if (issue) {
      if (issue.title !== title || issue.body !== body) {
        // Update the issue. This might happen as a result of a change in
        // web-features or if we change the format of the issue body.
        if (dryRun) {
          console.log(`Dry run. Would update issue for ${id}.`);
          continue;
        }
        console.log(`Updating issue for ${id}.`);
        await octokit.rest.issues.update({
          ...params,
          issue_number: issue.number,
          title,
          body,
          // Labels are not updated to avoid removing labels added manually.
        });
      } else {
        console.log(`Issue for ${id} is up-to-date.`);
      }
      manifest.set(id, {
        url: issue.html_url,
        // Only count 👍 reactions as "votes".
        votes: issue.reactions['+1'],
      });
    } else {
      // Create a new issue.
      if (dryRun) {
        console.log(`Dry run. Would create new issue for ${id}.`);
        continue;
      }
      console.log(`Creating new issue for ${id}.`);
      const response = await octokit.rest.issues.create({
        ...params,
        title,
        body,
        labels: ["feature"],
      });
      manifest.set(id, {
        url: response.data.html_url,
        votes: 0,
      });
    }
  }

  // Serialize the manifest to a JSON object with sorted keys.
  const ids = Array.from(manifest.keys()).sort();
  const manifestJson = JSON.stringify(
    Object.fromEntries(ids.map((id) => [id, manifest.get(id)])));
  await writeFile("web-features-signals.json", manifestJson);
  console.log('Wrote web-features-signals.json');

  // TODO: close open issues that were skipped / not updated.
}

await update();
