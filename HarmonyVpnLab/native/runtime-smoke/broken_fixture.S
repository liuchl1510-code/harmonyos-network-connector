// Deliberately violate preservation of x25. This negative control must fail
// with mask 64 before the loader is used to judge a Go runtime candidate.
.text
.p2align 2
.global HarmonyGoSmoke
.type HarmonyGoSmoke, %function
HarmonyGoSmoke:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    bl NativeSmokeBody
    mov x25, #0xbad
    ldp x29, x30, [sp], #16
    ret
.size HarmonyGoSmoke, .-HarmonyGoSmoke
.section .note.GNU-stack,"",%progbits
