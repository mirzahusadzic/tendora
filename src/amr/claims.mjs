/** The assertion focus survives role normalization independently of serialization. */
export const claimRoot = (graph) => graph.assertionTop ?? graph.top;
