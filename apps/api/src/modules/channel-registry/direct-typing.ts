// A channel whose customers are reached by the api itself (a socket it holds) and not through the outbound queue
// and the worker. The list under DIRECT_TYPING_DELIVERIES is one provider, assembled in the module that composes
// the channels the api reaches itself (today the widget's delivery module); the relay of the typing of an agent
// asks it by plugin id and knows no channel. A second such channel adds its entry there (Nest does not merge
// providers of one token): a collector with a register method is the step after A6b, when the widget's routes
// move into its plugin module.
export interface DirectTypingDelivery {
  readonly pluginId: string
  // `connectionId` is the account the conversation belongs to, `identity` the handle of the customer
  typing(connectionId: string, identity: string, active: boolean): void
}
export const DIRECT_TYPING_DELIVERIES = Symbol('DIRECT_TYPING_DELIVERIES')
