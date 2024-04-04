/* eslint-disable @typescript-eslint/explicit-function-return-type */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { Octokit } from '@octokit/core'
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods'
import { throttling } from '@octokit/plugin-throttling'
import * as core from '@actions/core'

const statusCheckRollupQuery = `query($owner: String!, $repo: String!, $pull_number: Int!) {
  repository(owner: $owner, name:$repo) {
    pullRequest(number:$pull_number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
            }
          }
        }
      }
    }
  }
}`

async function getCombinedSuccess(
  octokit: Octokit,
  { owner, repo, pull_number }
) {
  const result = await octokit.graphql(statusCheckRollupQuery, {
    owner,
    repo,
    pull_number
  })
  const [{ commit: lastCommit }] = result.repository.pullRequest.commits.nodes
  console.log('getCombinedSuccess', {
    statusCheckRollup: lastCommit?.statusCheckRollup
  })
  return (
    !lastCommit.statusCheckRollup ||
    lastCommit.statusCheckRollup.state === 'SUCCESS'
  )
}

export async function main() {
  try {
    const trunkBranch = process.env.TRUNK_BRANCH

    if (!trunkBranch) {
      throw new Error('You need to specificy TRUNK_BRANCH')
    }

    const MyOctokit = Octokit.plugin(restEndpointMethods, throttling)

    console.log('we got past auth')
    const octokit = new MyOctokit({
      auth: process.env.GITHUB_TOKEN,
      throttle: {
        onRateLimit: (retryAfter, options, octo, retryCount) => {
          octo.log.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`
          )

          if (retryCount < 1) {
            // only retries once
            octo.log.info(`Retrying after ${retryAfter} seconds!`)
            return true
          }
        },
        onSecondaryRateLimit: (retryAfter, options, octo) => {
          // does not retry, only logs a warning
          octo.log.warn(
            `SecondaryRateLimit detected for request ${options.method} ${options.url}`
          )
        }
      }
    })

    const ownerAndRepo = process.env.GITHUB_REPOSITORY.split('/')
    const [owner, repo] = ownerAndRepo

    const pull_number = process.env.GITHUB_REF_NAME?.split('/')?.[0]
    core.info('pull_number', pull_number)

    const currentPR = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number
    })

    const descendantPRs = [currentPR.data]
    let nextPR = currentPR.data
    let finalPR

    const allOpenPRs = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open'
    })

    while (nextPR.base.ref !== trunkBranch) {
      const nextHead = nextPR?.base?.ref

      const nextHeadPRs = allOpenPRs.data.filter(pr => pr.head.ref === nextHead)

      if (nextHeadPRs.length !== 1) {
        throw new Error(
          `The chain of PRs is broken because we could not find a PR with the specified base ${nextPR.data.base.ref} or we found more than one`
        )
      }

      const pr = nextHeadPRs[0]

      const commits = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: pr.number
      })

      if (commits.data.length > 1) {
        throw new Error(`PR #${pr.number} has more than one commit`)
      }

      // TODO: verify that commit has linear ticket??

      const status = await getCombinedSuccess(octokit, {
        owner,
        repo,
        pull_number: pr.number
      })

      if (!status) {
        throw new Error(`PR # ${pr.number} has failing merge checks`)
      }

      if (pr.base.ref !== trunkBranch) {
        descendantPRs.push(pr)
      } else {
        finalPR = pr
      }

      nextPR = pr
    }

    for (const pr of descendantPRs) {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pr.number
      })
    }

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: finalPR.number,
      labels: ['merge-stack']
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}
