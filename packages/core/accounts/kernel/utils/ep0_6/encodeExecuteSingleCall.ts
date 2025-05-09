import { encodeFunctionData } from "viem"
import { KernelExecuteAbi } from "../../abi/KernelAccountAbi.js"
import type { CallArgs } from "../types.js"

export const encodeExecuteSingleCall = (args: CallArgs) => {
    return encodeFunctionData({
        abi: KernelExecuteAbi,
        functionName: "execute",
        args: [args.to, args.value || 0n, args.data || "0x", 0]
    })
}
