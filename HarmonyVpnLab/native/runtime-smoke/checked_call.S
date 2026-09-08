// AAPCS64 C boundary check, independent of the tested Go implementation.
// Bits 0..9 correspond to x19..x28. Restore the caller's original registers
// even if the tested function violates its ABI, so a failure is observable.
.text
.p2align 2
.global harmony_checked_call
.type harmony_checked_call, %function
harmony_checked_call:
    .cfi_startproc
    stp x29, x30, [sp, #-112]!
    .cfi_def_cfa_offset 112
    .cfi_offset x29, -112
    .cfi_offset x30, -104
    stp x19, x20, [sp, #16]
    stp x21, x22, [sp, #32]
    stp x23, x24, [sp, #48]
    stp x25, x26, [sp, #64]
    stp x27, x28, [sp, #80]
    str x2, [sp, #96]
    mov x29, sp
    mov x9, x0
    mov x0, x1
    mov x19, #0x1919
    mov x20, #0x2020
    mov x21, #0x2121
    mov x22, #0x2222
    mov x23, #0x2323
    mov x24, #0x2424
    mov x25, #0x2525
    mov x26, #0x2626
    mov x27, #0x2727
    mov x28, #0x2828
    blr x9
    ldr x10, [sp, #96]
    cbz x10, .Lno_reply
    str x0, [x10]
.Lno_reply:
    mov w0, wzr
.macro check_saved reg, value, flag
    mov x10, #\value
    cmp \reg, x10
    b.eq .Lsame\@
    orr w0, w0, #\flag
.Lsame\@:
.endm
    check_saved x19, 0x1919, 1
    check_saved x20, 0x2020, 2
    check_saved x21, 0x2121, 4
    check_saved x22, 0x2222, 8
    check_saved x23, 0x2323, 16
    check_saved x24, 0x2424, 32
    check_saved x25, 0x2525, 64
    check_saved x26, 0x2626, 128
    check_saved x27, 0x2727, 256
    check_saved x28, 0x2828, 512
    ldp x19, x20, [sp, #16]
    ldp x21, x22, [sp, #32]
    ldp x23, x24, [sp, #48]
    ldp x25, x26, [sp, #64]
    ldp x27, x28, [sp, #80]
    ldp x29, x30, [sp], #112
    .cfi_def_cfa_offset 0
    ret
    .cfi_endproc
.size harmony_checked_call, .-harmony_checked_call
.section .note.GNU-stack,"",%progbits
