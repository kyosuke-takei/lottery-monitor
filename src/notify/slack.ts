import axios from "axios"

export async function postToSlack(text: string) {

  const url = process.env.SLACK_WEBHOOK_URL

  if (!url) {
    console.log("SLACK_WEBHOOK_URL 未設定")
    return
  }

  await axios.post(url, { text })
}