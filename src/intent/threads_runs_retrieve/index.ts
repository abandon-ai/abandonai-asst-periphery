import redisClient from "../../utils/redisClient";
import sqsClient from "../../utils/sqsClient";
import {ChangeMessageVisibilityCommand} from "@aws-sdk/client-sqs";
import backOffSecond from "../../utils/backOffSecond";
import {functionHandlerMap} from "../../tools/telegram";
import {SQSRecord} from "aws-lambda";
import OpenAI from "openai";

const Threads_runs_retrieve = async (record: SQSRecord) => {
  const {body, receiptHandle} = record;
  const nextNonce = await redisClient.incr(receiptHandle);
  const openai = new OpenAI();

  console.log("nextNonce", nextNonce);
  console.log("backOffSecond", backOffSecond(nextNonce - 1));
  const {thread_id, run_id, assistant_id, token, chat_id} = JSON.parse(body);
  console.log("threads.runs.retrieve...");
  try {
    const {status, required_action, expires_at} = await openai.beta.threads.runs.retrieve(thread_id, run_id);
    console.log(status);
    await redisClient.set(`${assistant_id}:${thread_id}:run`, run_id, {
      exat: expires_at,
    });
    switch (status) {
      case "queued":
      case "in_progress":
        fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id,
            action: "typing",
          })
        }).catch((e) => {
          console.log('SendChatAction error', e);
        })
        await sqsClient.send(new ChangeMessageVisibilityCommand({
          QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: backOffSecond(nextNonce - 1),
        }))
        throw new Error("queued or in_progress");
      case "requires_action":
        await redisClient.del(receiptHandle);
        if (!required_action) {
          console.log("Required action not found");
          break;
        }
        const tool_calls = required_action.submit_tool_outputs.tool_calls;
        let tool_outputs_promises = [];
        for (const toolCall of tool_calls) {
          const function_name = toolCall.function.name;
          console.log("function_name", function_name);
          const handler = functionHandlerMap[function_name!];
          if (handler) {
            // Instead of awaiting each handler, push the promise into an array
            tool_outputs_promises.push(handler(toolCall, assistant_id));
          } else {
            console.log(`Function ${function_name} not found`);
          }
        }
        if (tool_outputs_promises.length === 0) {
          console.log("No tool outputs found");
          break;
        }
        const tool_outputs = await Promise.all(tool_outputs_promises);
        try {
          openai.beta.threads.runs.submitToolOutputs(thread_id, run_id, {
            tool_outputs,
          });
        } catch (e) {
          console.log("Failed to submit tool outputs", e);
        }
        break;
      case "cancelling":
      case "completed":
      case "failed":
      case "cancelled":
      case "expired":
      default:
        await redisClient.del(receiptHandle);
        break;
    }
  } catch (e) {
    await sqsClient.send(new ChangeMessageVisibilityCommand({
      QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: backOffSecond(nextNonce - 1),
    }))
    throw new Error("Failed to retrieve run");
  }
}

export default Threads_runs_retrieve;