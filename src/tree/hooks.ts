// Extension points for feature modules that add nodes to the explorer tree
// without the explorer importing them (avoids import cycles):
//   treeHooks.registerStreamChildren(...)     → extra children under each stream (before consumers)
//   treeHooks.registerConnectionChildren(...) → extra folders under each live connection (after Services)

import type * as vscode from "vscode";
import type { StreamInfo } from "@nats-io/jetstream";
import type { LiveConnection } from "../core/connectionManager";
import type { NatsNode } from "./base";
import { log } from "../core/log";

export interface StreamHookArgs {
  connId: string;
  parent: NatsNode;
  lc: LiveConnection;
  info: StreamInfo;
}

export interface ConnectionHookArgs {
  connId: string;
  parent: NatsNode;
  lc: LiveConnection;
}

type Provider<A> = (args: A) => NatsNode[] | Promise<NatsNode[]>;

class TreeHooks {
  private readonly stream: Provider<StreamHookArgs>[] = [];
  private readonly connection: Provider<ConnectionHookArgs>[] = [];

  get hasStreamChildren(): boolean {
    return this.stream.length > 0;
  }

  registerStreamChildren(p: Provider<StreamHookArgs>): vscode.Disposable {
    this.stream.push(p);
    return { dispose: () => this.stream.splice(this.stream.indexOf(p), 1) };
  }

  registerConnectionChildren(p: Provider<ConnectionHookArgs>): vscode.Disposable {
    this.connection.push(p);
    return { dispose: () => this.connection.splice(this.connection.indexOf(p), 1) };
  }

  streamChildren(args: StreamHookArgs): Promise<NatsNode[]> {
    return collect(this.stream, args);
  }

  connectionChildren(args: ConnectionHookArgs): Promise<NatsNode[]> {
    return collect(this.connection, args);
  }
}

async function collect<A>(providers: Provider<A>[], args: A): Promise<NatsNode[]> {
  const out: NatsNode[] = [];
  for (const p of providers) {
    try {
      out.push(...(await p(args)));
    } catch (e) {
      log.debug(`tree hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export const treeHooks = new TreeHooks();
