/**
 * AWS Lambda entry point (handler: dist/lambda.handler) behind a Function URL.
 * Configuration comes from Lambda environment variables (STORE, DYNAMODB_TABLE, HOUSEHOLD_KEYS, BEDROCK_REGION, ...).
 */
import serverless from "serverless-http";
import { createApp } from "./app.js";

export const handler = serverless(createApp());
