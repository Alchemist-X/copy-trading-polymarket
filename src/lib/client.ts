import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { getConfig, getRequiredClientConfig } from "./config.js";

export const HOST = getConfig().clobHost;
export const CHAIN_ID = 137;

export interface ClientEnv {
  privateKey: string;
  funderAddress: string;
  signatureType: number;
  eoaAddress: string;
}

export function loadEnv(): ClientEnv {
  const cfg = getRequiredClientConfig();
  return {
    privateKey: cfg.privateKey,
    funderAddress: cfg.funderAddress,
    signatureType: cfg.signatureType,
    eoaAddress: new Wallet(cfg.privateKey).address,
  };
}

export async function initClient(env: ClientEnv): Promise<ClobClient> {
  const signer = new Wallet(env.privateKey);
  const temp = new ClobClient(HOST, CHAIN_ID, signer);
  const creds = await temp.deriveApiKey();
  return new ClobClient(HOST, CHAIN_ID, signer, creds, env.signatureType, env.funderAddress);
}
