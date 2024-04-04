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
  {
    owner,
    repo,
    pull_number
  }: { owner: string; repo: string; pull_number: number }
) {
  const result = await octokit.graphql(statusCheckRollupQuery, {
    owner,
    repo,
    pull_number
  })
  // @ts-expect-error Need to codegen GQL return. Can't find rest api equivalent?
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
    const trunkBranch = core.getInput('TRUNK_BRANCH', { required: true })

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

    if (!process.env.GITHUB_REPOSITORY) {
      throw new Error('GITHUB_REPOSITORY env var missing?')
    }

    const ownerAndRepo = process.env.GITHUB_REPOSITORY.split('/')
    const [owner, repo] = ownerAndRepo

    if (!process.env.GITHUB_REF_NAME) {
      throw new Error('GITHUB_REF_NAME env var missing?')
    }

    const pull_number = parseInt(process.env.GITHUB_REF_NAME.split('/')[0])

    const allOpenPRs = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open'
    })

    const currentPR = allOpenPRs.data.filter(pr => (pr.number = pull_number))

    const descendantPRs = [currentPR[0]]
    let nextPR = currentPR[0]
    let finalPR

    while (nextPR.base.ref !== trunkBranch) {
      const nextHead: string = nextPR?.base?.ref

      const nextHeadPRs = allOpenPRs.data.filter(pr => pr.head.ref === nextHead)

      if (nextHeadPRs.length !== 1) {
        throw new Error(
          `The chain of PRs is broken because we could not find a PR with the specified base ${nextPR.base.ref} or we found more than one`
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

    if (!finalPR) {
      throw new Error('We left without a final PR')
    }

    for (const pr of descendantPRs) {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pr.number,
        merge_method: 'rebase'
      })
    }

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: finalPR.number,
      labels: ['merge-stack']
    })
  } catch (error) {
    // @ts-expect-error unknown errors
    core.setFailed(error.message)
  }
}
