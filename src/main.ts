/* eslint-disable @typescript-eslint/explicit-function-return-type */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { Octokit } from '@octokit/core'
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods'
import * as core from '@actions/core'
// import { execSync } from 'child_process'
// import { createActionAuth } from '../node_modules/@octokit/auth-action'

// async function findOpenPRs(octokit, commitSHA) {
//   const { data: issues } = await octokit.search.issuesAndPullRequests({
//     q: `is:open is:pr ${commitSHA}`
//   })

//   return issues.items.filter(issue => issue.pull_request)
// }

// async function getTargetBranch(octokit, prURL) {
//   const pr = await octokit.request(prURL)
//   return pr.data.base.ref
// }

export async function main() {
  try {
    // const auth = createActionAuth()
    // const authentication = await auth()

    const trunkBranch = process.env.TRUNK_BRANCH

    if (!trunkBranch) {
      throw new Error('You need to specificy TRUNK_BRANCH')
    }

    const MyOctokit = Octokit.plugin(restEndpointMethods)

    console.log('we got past auth')
    const octokit = new MyOctokit({
      auth: process.env.GITHUB_TOKEN
      // baseUrl: process.env.GITHUB_API_URL
    })

    const ownerAndRepo = process.env.GITHUB_REPOSITORY?.split('/')
    const owner = ownerAndRepo[0]
    const repo = ownerAndRepo[1]

    const pull_number = process.env.GITHUB_REF_NAME?.split('/')?.[0]
    // get current PR
    console.log('pull_number', pull_number)

    const currentPR = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number
    })

    // console.log('currentPR', currentPR.data)

    const descendantPRs = []
    let nextPR = currentPR

    console.log('envvars', process.env)

    const allOpenPRs = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open'
      // head: nextPR.data.base.ref
    })

    // TODO: can we find trunk branch from envars?
    while (nextPR.data.base.ref !== process.env.TRUNK_BRANCH) {
      const nextHead = nextPR.data.base.ref

      const nextHeadPRs = allOpenPRs.data.filter(pr => pr.base.ref === nextHead)
      console.log('prList', {
        nextHead: nextPR.data.base.ref,
        nextHeadPRs
      })

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

      console.log('commits', commits)

      if (commits.data.length > 1) {
        throw new Error(`PR #${pr.number} has more than one commit`)
      }

      descendantPRs.push(pr)

      nextPR = pr
    }

    console.log('somehow we got out?', descendantPRs)

    // const commitSHA = process.env.GITHUB_SHA

    // const openPRs = await findOpenPRs(octokit, commitSHA)
    // if (openPRs.length === 0) {
    //   core.info('No open PRs found.')
    //   return
    // }

    // const pr = openPRs[0]
    // const targetBranch = await getTargetBranch(octokit, pr.pull_request.url)

    // console.log('targetBranch', targetBranch)

    // if (targetBranch === 'develop') {
    //   core.info("Final PR found targeting 'develop'. Rebase and merge...")
    //   execSync(`git fetch origin ${pr.head.ref}`)
    //   execSync(`git checkout -b pr-${pr.number}-branch FETCH_HEAD`)
    //   execSync(`git rebase origin/develop`)
    //   execSync(`git push origin pr-${pr.number}-branch:refs/heads/develop`)
    //   execSync(
    //     `gh pr merge --squash --delete-branch --auto -m "Rebased and merged PR into develop" ${pr.number}`
    //   )
    // } else {
    //   core.info("Target branch is not 'develop'. Merging...")
    //   execSync(`git fetch origin ${pr.head.ref}`)
    //   execSync(`git checkout -b pr-${pr.number}-branch FETCH_HEAD`)
    //   execSync(`git merge --no-ff --no-edit ${commitSHA}`)
    //   execSync(`git push origin pr-${pr.number}-branch:${targetBranch}`)
    // }
  } catch (error) {
    core.setFailed(error.message)
  }
}
