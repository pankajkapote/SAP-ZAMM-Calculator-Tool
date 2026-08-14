# SAP ZAMM Calculator - Complete Documentation

## Overview

The **Zero Administration Memory Management (ZAMM) Calculator** is a comprehensive web-based tool designed to help SAP Basis administrators automatically calculate and validate memory parameter configurations across different SAP systems and operating systems.

This tool is built on the recommendations from SAP's official OSS Notes and supports:
- **Windows Server** (64-bit) systems
- **Linux** (64-bit) systems  
- **UNIX** (AIX/Solaris) systems
- **SAP Kernel 7.40+** for full ZAMM support

---

## Key Features

### 1. **Automated ZAMM Calculation**
- Automatically calculates all required memory parameters based on physical RAM
- Supports multiple operating systems with OS-specific parameter sets
- Accounts for co-located databases and other applications

### 2. **Profile Validation**
- Upload existing SAP instance profiles or default profiles
- Automatic detection of ZAMM enabled/disabled status
- Comparison of current parameters vs. calculated optimal values
- Highlights parameters that are:
  - ✓ OK (within acceptable range)
  - ⚠ LOWER (may cause performance issues)
  - ⚠ HIGHER (may waste resources)

### 3. **Detailed Analysis**
- Parameter-by-parameter impact assessment
- Guidelines for action items with root cause analysis
- OS-specific memory implementation guidance
- Links to relevant SAP OSS Notes

### 4. **Report Generation**
- Export detailed analysis to PDF
- Copy calculated parameters to clipboard
- Action items with custom notes field

---

## Understanding ZAMM

### What is ZAMM?

Zero Administration Memory Management (ZAMM) is a SAP Kernel feature (available since Kernel 7.40) that automatically configures memory-related profile parameters based on the system's physical RAM. This eliminates the need for manual memory parameter tuning.

### Why Use ZAMM?

| Benefit | Impact |
|---------|--------|
| **Automatic Scaling** | Memory parameters automatically adapt to physical RAM size |
| **Reduced Errors** | No manual misconfiguration of critical memory settings |
| **Optimal Performance** | System uses appropriate memory allocation based on actual resources |
| **Simplified Operations** | Less administrative overhead for memory management |
| **Future-proof** | Works across different hardware configurations |

### How ZAMM Works

**Windows (SAP Note 88416):**
1. System reads `PHYS_MEMSIZE` parameter (= physical RAM)
2. Automatically calculates:
   - `em/initial_size_MB` = min(512000, PHYS_MEMSIZE * 1024 * 0.7)
   - `em/max_size_MB` = PHYS_MEMSIZE * 1024 * 0.9
   - `EM/TOTAL_SIZE_MB` = PHYS_MEMSIZE * 1024 * 0.7
   - Pagefile size = PHYS_MEMSIZE * 2

**Linux/UNIX (SAP Note 941735 & 3681846):**
1. For 64-bit systems: use `es/implementation=std` (STD implementation)
2. All user contexts share same address space
3. Automatically derive memory areas:
   - Extended Memory (EM) pool
   - Global area
   - Shared objects

---

## Input Parameters

### Required Inputs

#### 1. **Operating System**
Select the target SAP application server OS:
- **Windows Server (64-bit)**: SAP on Windows platforms
- **Linux (64-bit)**: Most common SAP environments
- **UNIX (AIX/Solaris)**: Legacy UNIX systems

#### 2. **Physical Memory (GB)**
Total available RAM on the application server VM/host.

**Example Values:**
- Small systems: 32-64 GB
- Medium systems: 128-256 GB  
- Large systems: 512+ GB

#### 3. **SAP Kernel Release**
- **7.40 (and above)**: Full ZAMM support with all features
- **7.21 to 7.39**: Limited ZAMM; some manual configuration may be needed

### Optional Inputs

#### 4. **Work Process Configuration**
- **Dialog (DIA)**: Default 30 processes
- **Batch (BTC)**: Default 20 processes
- **Spool (SPO)**: Default 1 process

*Note: ZAMM doesn't directly use these for memory calculation but are informational*

#### 5. **Co-located Applications**
If database or other applications run on same VM:
- **Database Memory**: Memory reserved for SAP HANA, Oracle, SQL Server, etc.
- **Other Application Memory**: Memory for non-SAP applications

*Important: Reserved memory is subtracted from available SAP memory*

#### 6. **Profile Upload (Optional)**
Upload existing SAP profile to:
- Validate current ZAMM status
- Compare current vs. calculated parameters
- Identify configuration gaps

---

## Core Memory Parameters

### Universal Parameters (All OS)

| Parameter | Purpose | Calculated From |
|-----------|---------|-----------------|
| `PHYS_MEMSIZE` | Main memory size in GB | Physical RAM on system |
| `em/initial_size_MB` | Initial EM pool at startup | 0.7 × PHYS_MEMSIZE (min 512000) |
| `EM/TOTAL_SIZE_MB` | Total EM available | 0.7 × PHYS_MEMSIZE |
| `em/max_size_MB` | Maximum EM extension limit | 0.9 × PHYS_MEMSIZE |

### Windows-Specific (SAP Note 88416)

| Parameter | Purpose | Value |
|-----------|---------|-------|
| `Pagefile_Size_GB` | Windows pagefile size | 2 × PHYS_MEMSIZE |
| `abap/heaplimit` | Max per-process memory | PHYS_MEMSIZE / WP_Count |
| `em/blocksize_KB` | Memory block granularity | 4096 KB (fixed) |

**Windows Note:**
- Pagefile must be configured as FIXED size (not dynamic)
- Too small pagefile → System crashes with error "1455: Paging file too small"
- Too large pagefile → Wastes disk space but safer than too small

### Linux/UNIX-Specific (SAP Note 941735 & 3681846)

| Parameter | Purpose | Value |
|-----------|---------|-------|
| `es/implementation` | Memory implementation type | `std` (for 64-bit) |
| `em/blocksize_KB` | Memory block granularity | 4096 KB |
| `em/global_area_MB` | Global shared area | 0.15 × EM_TOTAL |
| `abap/shared_objects_size_MB` | Shared objects pool | 0.1 × EM_TOTAL |

**Linux/UNIX Note:**
- Use `es/implementation=std` (STD) for all 64-bit systems (Kernel 7.10+)
- MAP implementation is legacy for 32-bit systems
- STD allows larger memory allocations and simplified management

---

## Calculation Examples

### Example 1: Windows Server with 256 GB RAM

**Input:**
- OS: Windows Server 64-bit
- Physical RAM: 256 GB
- Kernel: 7.40+
- No co-located apps

**Calculation:**
```
Available for SAP = 256 GB (no reservations)

PHYS_MEMSIZE = 256 GB
em/initial_size_MB = min(512000, 256 × 1024 × 0.7) = min(512000, 184320) = 184320 MB
em/max_size_MB = 256 × 1024 × 0.9 = 235520 MB
EM/TOTAL_SIZE_MB = 256 × 1024 × 0.7 = 184320 MB
Pagefile_Size = 256 × 2 = 512 GB
abap/heaplimit = 256 × 1024 / 30 = 8704 MB (assuming 30 dialog WPs)
```

**Profile Settings:**
```
PHYS_MEMSIZE = 256
em/initial_size_MB = 184320
em/max_size_MB = 235520
EM/TOTAL_SIZE_MB = 184320
Pagefile = 512 GB (fixed, not system-managed)
```

**Impact:**
- ✓ ZAMM enabled: All parameters auto-calculated
- ✓ Optimal memory distribution
- ✓ No manual tuning needed

---

### Example 2: Linux Server with Database Co-location

**Input:**
- OS: Linux 64-bit
- Physical RAM: 512 GB
- Kernel: 7.40+
- SAP HANA Database: 300 GB allocated

**Calculation:**
```
Total Physical = 512 GB
Reserved for Database = 300 GB
Available for SAP = 512 - 300 = 212 GB

es/implementation = std
em/initial_size_MB = min(512000, 212 × 1024 × 0.7) = min(512000, 152576) = 152576 MB
EM/TOTAL_SIZE_MB = 212 × 1024 × 0.7 = 152576 MB
em/global_area_MB = 152576 × 0.15 = 22886 MB
abap/shared_objects_size_MB = 152576 × 0.1 = 15257 MB
```

**Action Items:**
- ⚠ Verify database memory allocation is correct (300 GB)
- ⚠ Ensure Linux `/proc/sys/kernel/shmmax` ≥ 152576 MB
- ✓ Apply calculated parameters to profile
- ✓ Verify ZAMM enabled after applying

---

## Profile Validation

### How Profile Validation Works

When you upload a profile, the tool:

1. **Extracts Current Parameters** from profile file
2. **Compares with ZAMM Calculated Values**
3. **Identifies Discrepancies**:
   - ✓ OK: Within ±10% of calculated value
   - ⚠ LOWER: <90% of recommended (potential issues)
   - ⚠ HIGHER: >110% of recommended (resource waste)

### Example Comparison

```
Parameter               Calculated    Current    Status
─────────────────────────────────────────────────────
PHYS_MEMSIZE           256 GB         256 GB     ✓ OK
em/initial_size_MB     184320 MB      150000 MB  ⚠ LOWER
em/max_size_MB         235520 MB      200000 MB  ⚠ LOWER
EM/TOTAL_SIZE_MB       184320 MB      184320 MB  ✓ OK
```

### Impact Analysis

**If em/initial_size_MB is TOO LOW:**

❌ Symptoms:
- Work processes terminate with "ROLL_FULL" errors
- Application server logs show memory allocation failures
- Users experience frequent connection drops
- Batch jobs fail to complete

✅ Solution:
- Increase em/initial_size_MB to recommended value
- Increase Pagefile/Swap space if needed
- Monitor `/proc/meminfo` on Linux

---

**If em/initial_size_MB is TOO HIGH:**

❌ Symptoms:
- System hangs during startup (can't allocate memory)
- Swap space rapidly consumed
- Overall system slowdown due to swapping

✅ Solution:
- Reduce em/initial_size_MB slightly
- Ensure adequate free physical RAM before restart
- Verify pagefile/swap is adequate

---

## SAP OSS Notes Reference

### 1. **SAP Note 88416**
**Title:** Zero administration memory management for the ABAP server

- **Component:** BC-OP-NT (Basis Components > Operating System Platforms > Windows)
- **Released:** 25.01.2024 (Version 45)
- **Applicability:** Windows Server, Kernel 7.40+
- **Key Topics:**
  - PHYS_MEMSIZE parameter configuration
  - em/initial_size_MB and em/max_size_MB calculation
  - Pagefile sizing and configuration
  - Windows-specific ZAMM implementation
- **Link:** https://me.sap.com/notes/88416

### 2. **SAP Note 941735**
**Title:** SAP memory management system for 64-bit Linux systems

- **Component:** BC-OP-LNX (Basis Components > Operating System Platforms > Linux)
- **Released:** 04.05.2018 (Version 11)
- **Applicability:** Linux 64-bit, Kernel 7.10+
- **Key Topics:**
  - MAP vs. STD implementation (es/implementation parameter)
  - Memory management for 64-bit systems
  - em/initial_size_MB configuration
  - Shared memory parameters
- **Link:** https://me.sap.com/notes/941735

### 3. **SAP Note 1518419**
**Title:** Windows Pagefile Sizing and Configuration

- **Component:** BC-OP-NT (Basis Components > Operating System Platforms > Windows)
- **Released:** 17.04.2024 (Version 15)
- **Applicability:** Windows Server with VIEW memory model
- **Key Topics:**
  - Pagefile sizing: minimum 2x RAM for production
  - Fixed vs. dynamic pagefile (must use fixed for SAP)
  - Memory pool and virtual memory concepts
  - Error 1455 prevention
- **Link:** https://me.sap.com/notes/1518419

### 4. **SAP Note 2085980**
**Title:** New features in memory management as of Kernel Release 7.40

- **Component:** BC-CST-MM (Basis Components > Client/Server Technology > Memory Management)
- **Released:** 13.09.2018 (Version 11)
- **Applicability:** Kernel 7.40+
- **Key Topics:**
  - Abolition of classic ROLL memory
  - Availability of ZAMM on UNIX platforms
  - EM/TOTAL_SIZE_MB parameter (new)
  - Parameter formulas and calculations
- **Link:** https://me.sap.com/notes/2085980

### 5. **SAP Note 3681846**
**Title:** Zero Administration Memory Management for ABAP on Linux/Unix servers

- **Component:** BC-OP-LNX (Basis Components > Operating System Platforms > Linux)
- **Released:** 13.11.2025 (Version 1)
- **Applicability:** Linux/UNIX SAP Netweaver 7.40+
- **Key Topics:**
  - ZAMM implementation for Linux/UNIX
  - Clarification on SAP Note 88416 for non-Windows
  - STD implementation guidelines
  - Extended Memory parameters
- **Link:** https://me.sap.com/notes/3681846

---

## Common Issues & Solutions

### Issue 1: "ZAMM Not Enabled"

**Symptom:** Uploaded profile doesn't show ZAMM status

**Cause:** 
- Kernel < 7.40
- Manual memory parameters set in profile
- Profile generated before ZAMM feature

**Solution:**
1. Upgrade SAP Kernel to 7.40+
2. Remove manual em/initial_size_MB, em/max_size_MB from profile
3. Keep only PHYS_MEMSIZE parameter
4. Restart application server to activate ZAMM

---

### Issue 2: "Memory Parameters are LOWER"

**Symptom:** Calculated values significantly higher than current

**Cause:**
- Profile created on smaller system
- Incomplete migration to new hardware
- Conservative parameter sizing

**Action:**
1. Back up current profile
2. Apply calculated parameters
3. Increase pagefile/swap space first
4. Restart application server (planned downtime)
5. Monitor initial memory usage
6. Check SM04 (Work Process Overview) after restart

**Impact if Not Fixed:**
- ROLL_FULL errors → work process terminates
- User sessions drop → business impact
- Batch jobs fail → delayed processing

---

### Issue 3: "Memory Parameters are HIGHER"

**Symptom:** Current values exceed recommendations

**Cause:**
- Over-provisioned based on conservative estimates
- Old parameters never revised
- Multiple manual adjustments over time

**Action:**
1. Investigate why higher values were set (check profile history)
2. Gradually reduce to recommended levels
3. Monitor system behavior after each reduction
4. Document changes in change management system

**Impact if Not Fixed:**
- Wasted memory resources
- Reduced headroom for other systems
- Inefficient resource utilization

---

## Usage Workflow

### Step 1: Gather System Information
```
- Physical RAM: lsblk, free -h (Linux) or System Properties (Windows)
- Current Kernel: disp+work -v or RZ10 (Parameter Maintenance)
- Application Server OS: uname -a (Linux) or systeminfo (Windows)
- Database info: select * from m_host_information (HANA)
```

### Step 2: Enter Basic Configuration
1. Open ZAMM Calculator tool
2. Select Operating System
3. Enter Physical Memory
4. Select Kernel Version
5. Review/adjust work process counts
6. Add co-located app memory if applicable

### Step 3: (Optional) Upload Profile
1. Extract profile file from SAP (RZ10 → Default Profile or Instance Profile)
2. Drag & drop into upload area OR click to select file
3. Wait for file to load (shows filename with ✓)

### Step 4: Calculate ZAMM
1. Click "Calculate ZAMM" button
2. Review Summary tab for key values
3. Check Detailed tab for full parameter list
4. Review OS-specific tab for implementation guidance

### Step 5: Analyze Results
1. If profile uploaded:
   - Review Profile Validation section
   - Check comparison table for discrepancies
   - Note parameters that are LOWER/HIGHER
2. Review Action Items for each flagged parameter
3. Document issues and action plan

### Step 6: Generate Report (Optional)
1. Add custom notes in "Action to Take" fields
2. Click "Generate PDF Report" to export
3. Use report for change management approval
4. Attach to change ticket in SAP Solution Manager

### Step 7: Apply Changes
1. Create change request with calculated parameters
2. Schedule planned downtime (application server restart needed)
3. Backup current profile
4. Update profile with new parameters
5. Increase pagefile/swap if needed (Windows/Linux)
6. Restart application server
7. Verify memory status in SM04/SM50

---

## Best Practices

### ✓ DO's

- ✓ Always back up profile before making changes
- ✓ Use ZAMM for all Kernel 7.40+ systems
- ✓ Validate parameters after applying with this tool
- ✓ Reserve memory for co-located applications
- ✓ Configure fixed-size pagefile on Windows (not dynamic)
- ✓ Monitor memory usage for 48 hours after restart
- ✓ Document changes in change management
- ✓ Review calculated values with system owner
- ✓ Use tool before every profile change
- ✓ Keep OSS Notes updated and referenced

### ✗ DON'Ts

- ✗ Don't manually set em/initial_size_MB if ZAMM enabled
- ✗ Don't use dynamic pagefile on Windows
- ✗ Don't apply changes without proper testing
- ✗ Don't ignore LOWER parameter warnings
- ✗ Don't change parameters without profile backup
- ✗ Don't assume old parameters are correct
- ✗ Don't skip validation after profile changes
- ✗ Don't ignore co-located application memory needs
- ✗ Don't downgrade kernel version
- ✗ Don't apply changes without system restart

---

## Advanced Topics

### Memory Pool Sizing Formula (SAP Note 2085980)

For **all systems**, the extended memory is calculated as:

```
em/initial_size_MB = min(512000, max(512000, PHYS_MEMSIZE × 1024 × 0.7))

Where:
- PHYS_MEMSIZE = Available physical memory in GB (after deducting DB, other apps)
- Multiplier 0.7 = 70% of physical memory reserved for EM
- Max limit = 512000 MB = 512 GB (practical limit)
```

**Why 70%?**
- 20-25% reserved for OS and buffer caches
- 5-10% overhead for kernel and other processes
- Ensures system stability and prevents OOM kills

### EM/TOTAL_SIZE_MB vs em/max_size_MB

| Parameter | Purpose | Behavior |
|-----------|---------|----------|
| `EM/TOTAL_SIZE_MB` | Limit for user context EM | Absolute maximum (soft limit) |
| `em/max_size_MB` | Maximum extension | Hard limit for EM growth |

**In ZAMM:**
- `EM/TOTAL_SIZE_MB` = 0.7 × PHYS_MEMSIZE
- `em/max_size_MB` = 0.9 × PHYS_MEMSIZE (additional headroom for growth)

### Windows Memory Model: VIEW vs FLAT

This tool uses the **VIEW model** (recommended):
- Extended memory extends dynamically up to em/max_size_MB
- Pagefile acts as overflow when physical RAM exhausted
- More efficient memory utilization

**Old FLAT model** (deprecated):
- All memory allocated upfront
- No dynamic extension
- Wastes memory if not all used

---

## Troubleshooting Guide

### Tool Issues

| Issue | Solution |
|-------|----------|
| File upload not working | Ensure file is text-based profile, not binary |
| Calculation not running | Check browser console (F12) for JavaScript errors |
| PDF export fails | Use Chrome/Edge browser, check pop-up blockers |
| Parameters don't calculate | Verify all required fields filled and valid numbers |

### Memory Issues After Applying

| Symptom | Cause | Fix |
|---------|-------|-----|
| App server won't start | EM too large, not enough physical RAM | Reduce em/initial_size_MB, increase swap/pagefile |
| Frequent work process termination | EM too small | Increase to calculated value, restart |
| System very slow | Swapping excessively | Reduce EM, verify pagefile size adequate |
| ROLL_FULL errors in log | em/max_size_MB too low | Increase per calculated value |

---

## Support & References

### Tool Created: August 2026

**Based on Official SAP OSS Notes:**
1. SAP Note 88416 - https://me.sap.com/notes/88416
2. SAP Note 941735 - https://me.sap.com/notes/941735
3. SAP Note 1518419 - https://me.sap.com/notes/1518419
4. SAP Note 2085980 - https://me.sap.com/notes/2085980
5. SAP Note 3681846 - https://me.sap.com/notes/3681846

### Supported SAP Versions
- SAP S/4HANA (All versions)
- SAP ECC 6.0+ with Kernel 7.40+
- SAP BW 7.5+ with Kernel 7.40+

### Testing Performed
- Windows Server 2019/2022 with various RAM sizes
- SUSE Linux Enterprise, Red Hat Enterprise Linux
- Different work process configurations
- Co-located HANA database scenarios

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│          SAP ZAMM QUICK REFERENCE - KERNEL 7.40+           │
├─────────────────────────────────────────────────────────────┤
│ KEY PARAMETER CALCULATION:                                  │
│                                                              │
│ PHYS_MEMSIZE = Total Physical RAM available                │
│ em/initial_size_MB = min(512000, PHYS_MEMSIZE*1024*0.7)    │
│ em/max_size_MB = PHYS_MEMSIZE × 1024 × 0.9                 │
│ EM/TOTAL_SIZE_MB = PHYS_MEMSIZE × 1024 × 0.7               │
│ Pagefile (Windows) = PHYS_MEMSIZE × 2                      │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│ VALIDATION CHECKLIST:                                       │
│ □ ZAMM enabled (Kernel 7.40+)                              │
│ □ PHYS_MEMSIZE set to available RAM                        │
│ □ em/initial_size_MB within ±10% of calculated            │
│ □ Pagefile fixed-size on Windows (not dynamic)            │
│ □ es/implementation=std on 64-bit Linux                   │
│ □ Reserved memory for co-located apps accounted            │
│ □ Sufficient swap/pagefile configured                     │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│ IMPACT SUMMARY:                                             │
│ • PHYS_MEMSIZE wrong → ZAMM doesn't work                   │
│ • em/initial_size_MB too low → ROLL_FULL, WP termination │
│ • em/initial_size_MB too high → Startup failures          │
│ • Pagefile too small → Error 1455, system crash           │
│ • Pagefile too large → Disk space waste                   │
│ • es/implementation wrong → Memory access issues           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Change Log

| Date | Version | Change |
|------|---------|--------|
| 14.08.2026 | 1.0 | Initial release - Full ZAMM calculator with profile validation |

---

**Created by:** SAP Basis Community  
**Last Updated:** August 14, 2026  
**Tool Version:** 1.0
