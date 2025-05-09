import type { TypedData } from "abitype"
import {
    type Abi,
    type Address,
    type Client,
    type Hex,
    type TypedDataDefinition,
    keccak256,
    pad,
    toHex,
    zeroAddress
} from "viem"
import { toAccount } from "viem/accounts"
import { getChainId, readContract, signMessage } from "viem/actions"
import { concat, concatHex, getAction } from "viem/utils"
import { SessionKeyValidatorAbi } from "./abi/SessionKeyValidatorAbi.js"

import { KernelAccountAbi, toSigner } from "@zerodev/sdk"
import { constants } from "@zerodev/sdk"
import type {
    EntryPointType,
    GetKernelVersion,
    Signer
} from "@zerodev/sdk/types"
import { MerkleTree } from "merkletreejs"
import {
    type EntryPointVersion,
    type UserOperation,
    getUserOperationHash
} from "viem/account-abstraction"
import { SESSION_KEY_VALIDATOR_ADDRESS } from "./index.js"
import type {
    SessionKeyData,
    SessionKeyPlugin,
    SessionNonces
} from "./types.js"
import {
    encodePermissionData,
    findMatchingPermissions,
    fixSignedData,
    getPermissionFromABI
} from "./utils.js"

export enum Operation {
    Call = 0,
    DelegateCall = 1
}

export enum ParamOperator {
    EQUAL = 0,
    GREATER_THAN = 1,
    LESS_THAN = 2,
    GREATER_THAN_OR_EQUAL = 3,
    LESS_THAN_OR_EQUAL = 4,
    NOT_EQUAL = 5
}

export const anyPaymaster = "0x0000000000000000000000000000000000000001"

export async function signerToSessionKeyValidator<
    entryPointVersion extends EntryPointVersion,
    TAbi extends Abi | readonly unknown[],
    TFunctionName extends string | undefined = string
>(
    client: Client,
    {
        signer,
        entryPoint,
        kernelVersion: _,
        validatorData,
        validatorAddress = SESSION_KEY_VALIDATOR_ADDRESS
    }: {
        signer: Signer
        validatorData?: SessionKeyData<TAbi, TFunctionName>
        entryPoint: EntryPointType<entryPointVersion>
        kernelVersion: GetKernelVersion<entryPointVersion>
        validatorAddress?: Address
    }
): Promise<SessionKeyPlugin> {
    if (entryPoint.version !== "0.6") {
        throw new Error("Only EntryPoint 0.6 is supported")
    }
    const sessionKeyData: SessionKeyData<TAbi, TFunctionName> = {
        ...validatorData,
        validAfter: validatorData?.validAfter ?? 0,
        validUntil: validatorData?.validUntil ?? 0,
        paymaster: validatorData?.paymaster ?? zeroAddress
    }
    const generatedPermissionParams = validatorData?.permissions?.map((perm) =>
        getPermissionFromABI({
            abi: perm.abi as Abi,
            functionName: perm.functionName as string,
            args: perm.args as []
        })
    )
    sessionKeyData.permissions =
        sessionKeyData.permissions?.map((perm, index) => ({
            ...perm,
            valueLimit: perm.valueLimit ?? 0n,
            sig:
                perm.sig ??
                generatedPermissionParams?.[index]?.sig ??
                pad("0x", { size: 4 }),
            rules:
                perm.rules ?? generatedPermissionParams?.[index]?.rules ?? [],
            index,
            executionRule: perm.executionRule ?? {
                validAfter: 0,
                interval: 0,
                runs: 0
            },
            operation: perm.operation ?? Operation.Call
        })) ?? []
    const viemSigner = await toSigner({ signer })

    // // Fetch chain id
    const [chainId] = await Promise.all([getChainId(client)])

    // Build the EOA Signer
    const account = toAccount({
        address: viemSigner.address,
        async signMessage({ message }) {
            return signMessage(client, { account: viemSigner, message })
        },
        async signTransaction(_, __) {
            throw new Error(
                "Smart account signer doesn't need to sign transactions"
            )
        },
        async signTypedData<
            const TTypedData extends TypedData | Record<string, unknown>,
            TPrimaryType extends
                | keyof TTypedData
                | "EIP712Domain" = keyof TTypedData
        >(typedData: TypedDataDefinition<TTypedData, TPrimaryType>) {
            return viemSigner.signTypedData(typedData)
        }
    })

    const encodedPermissionData = sessionKeyData.permissions.map((permission) =>
        encodePermissionData(permission)
    )

    if (encodedPermissionData.length && encodedPermissionData.length === 1)
        encodedPermissionData.push(encodedPermissionData[0])

    const merkleTree: MerkleTree = sessionKeyData.permissions?.length
        ? new MerkleTree(encodedPermissionData, keccak256, {
              sortPairs: true,
              hashLeaves: true
          })
        : new MerkleTree([pad("0x00", { size: 32 })], keccak256, {
              hashLeaves: false,
              complete: true
          })

    const getEnableData = async (
        kernelAccountAddress?: Address,
        enabledLastNonce?: bigint
    ): Promise<Hex> => {
        if (!kernelAccountAddress) {
            throw new Error("Kernel account address not provided")
        }
        const lastNonce =
            enabledLastNonce ??
            (await getSessionNonces(kernelAccountAddress)).lastNonce + 1n
        return concat([
            viemSigner.address,
            pad(merkleTree.getHexRoot() as Hex, { size: 32 }),
            pad(toHex(sessionKeyData?.validAfter ?? 0), {
                size: 6
            }),
            pad(toHex(sessionKeyData?.validUntil ?? 0), {
                size: 6
            }),
            sessionKeyData?.paymaster ?? zeroAddress,
            pad(toHex(lastNonce), { size: 32 })
        ])
    }

    const getSessionNonces = async (
        kernelAccountAddress: Address
    ): Promise<SessionNonces> => {
        const nonce = await getAction(
            client,
            readContract,
            "readContract"
        )({
            abi: SessionKeyValidatorAbi,
            address: validatorAddress,
            functionName: "nonces",
            args: [kernelAccountAddress]
        })

        return { lastNonce: nonce[0], invalidNonce: nonce[1] }
    }

    const getEncodedPermissionProofData = (callData: Hex): Hex => {
        const matchingPermission = findMatchingPermissions(
            callData,
            sessionKeyData?.permissions
        )
        if (
            !matchingPermission &&
            !(merkleTree.getHexRoot() === pad("0x00", { size: 32 }))
        ) {
            throw Error(
                "SessionKeyValidator: No matching permission found for the userOp"
            )
        }
        const encodedPermissionData =
            sessionKeyData?.permissions &&
            sessionKeyData.permissions.length !== 0 &&
            matchingPermission
                ? encodePermissionData(matchingPermission)
                : "0x"
        let merkleProof: string[] | string[][] = []
        if (Array.isArray(matchingPermission)) {
            const encodedPerms = matchingPermission.map((permission) =>
                keccak256(encodePermissionData(permission))
            )
            merkleProof = encodedPerms.map((perm) =>
                merkleTree.getHexProof(perm)
            )
        } else if (matchingPermission) {
            merkleProof = merkleTree.getHexProof(
                keccak256(encodedPermissionData)
            )
        }
        return sessionKeyData?.permissions &&
            sessionKeyData.permissions.length !== 0 &&
            matchingPermission
            ? encodePermissionData(matchingPermission, merkleProof)
            : "0x"
    }

    return {
        ...account,
        supportedKernelVersions: "0.0.2 - 0.2.4",
        validatorType: "SECONDARY",
        address: validatorAddress,
        source: "SessionKeyValidator",
        getIdentifier: () => validatorAddress,
        getEnableData,

        signUserOperation: async (userOperation): Promise<Hex> => {
            const userOpHash = getUserOperationHash({
                userOperation: {
                    ...userOperation,
                    signature: "0x"
                } as UserOperation<entryPointVersion>,
                entryPointAddress: entryPoint.address,
                entryPointVersion: entryPoint.version,
                chainId: chainId
            })

            const signature = await signMessage(client, {
                account: viemSigner,
                message: { raw: userOpHash }
            })
            const fixedSignature = fixSignedData(signature)
            return concat([
                viemSigner.address,
                fixedSignature,
                getEncodedPermissionProofData(userOperation.callData)
            ])
        },

        async getNonceKey(_accountAddress?: Address, customNonceKey?: bigint) {
            if (customNonceKey) {
                return customNonceKey
            }
            return 0n
        },

        async getStubSignature(userOperation) {
            return concat([
                viemSigner.address,
                constants.DUMMY_ECDSA_SIG,
                getEncodedPermissionProofData(userOperation.callData)
            ])
        },
        getPluginSerializationParams: (): SessionKeyData<Abi, string> =>
            sessionKeyData as SessionKeyData<Abi, string>,
        isEnabled: async (
            kernelAccountAddress: Address,
            selector: Hex
        ): Promise<boolean> => {
            try {
                const execDetail = await getAction(
                    client,
                    readContract,
                    "readContract"
                )({
                    abi: KernelAccountAbi,
                    address: kernelAccountAddress,
                    functionName: "getExecution",
                    args: [selector]
                })
                const enableData = await getAction(
                    client,
                    readContract,
                    "readContract"
                )({
                    abi: SessionKeyValidatorAbi,
                    address: validatorAddress,
                    functionName: "sessionData",
                    args: [signer.address as Address, kernelAccountAddress]
                })
                const enableDataHex = concatHex([
                    viemSigner.address,
                    pad(enableData[0], { size: 32 }),
                    pad(toHex(enableData[1]), { size: 6 }),
                    pad(toHex(enableData[2]), { size: 6 }),
                    enableData[3],
                    pad(toHex(enableData[4]), { size: 32 })
                ])
                return (
                    execDetail.validator.toLowerCase() ===
                        validatorAddress.toLowerCase() &&
                    enableData[4] !== 0n &&
                    enableDataHex.toLowerCase() ===
                        (
                            await getEnableData(
                                kernelAccountAddress,
                                enableData[4]
                            )
                        ).toLowerCase()
                )
            } catch (error) {
                return false
            }
        }
    }
}
