'use strict'

const AWS = require('aws-sdk')
const S3 = new AWS.S3({})
const SQS = new AWS.SQS({})

const marketing = require('../marketing')

const queue_url = process.env.SQS_QUEUE_URL

const main = async () => {
  console.log(`Fetching message from ${queue_url}`)
  const messages = await SQS.receiveMessage({
    MaxNumberOfMessages: 1,
    QueueUrl: queue_url
  }).promise()

  for (const message of messages.Messages) {
    const s3_notification = JSON.parse(message.Body)

    if (!s3_notification.Records) {
      break;
    }

    for (const s3_object of s3_notification.Records) {
      const s3_bucket = s3_object.s3.bucket.name
      const s3_key = s3_object.s3.object.key

      console.log(`Fetching file from s3://${s3_bucket}/${s3_key}`)
      const remote_file_stream = S3.getObject({
        Bucket: s3_bucket,
        Key: s3_key
      }).createReadStream()

      const eventCount = await marketing.processStream(remote_file_stream)
      console.log(`Done sending ${eventCount} events to Amplitude`)

      // TODO: Delete message from SQS after successful send
    }
  }
}

main()
