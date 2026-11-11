//go:build darwin

package proc

/*
#include <stdint.h>
#include <mach/mach.h>
#include <mach/host_info.h>

static kern_return_t kb_host_memory_pages(uint64_t *free_pages, uint64_t *inactive_pages, uint64_t *speculative_pages, uint64_t *purgeable_pages) {
	vm_statistics64_data_t stats;
	mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
	mach_port_t host = mach_host_self();
	kern_return_t result = host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&stats, &count);
	mach_port_deallocate(mach_task_self(), host);
	if (result != KERN_SUCCESS) return result;
	*free_pages = stats.free_count;
	*inactive_pages = stats.inactive_count;
	*speculative_pages = stats.speculative_count;
	*purgeable_pages = stats.purgeable_count;
	return KERN_SUCCESS;
}
*/
import "C"

import (
	"fmt"
	"math"
)

func darwinAvailableMemory(pageSize uint64) (uint64, error) {
	var free, inactive, speculative, purgeable C.uint64_t
	if status := C.kb_host_memory_pages(&free, &inactive, &speculative, &purgeable); status != C.KERN_SUCCESS {
		return 0, fmt.Errorf("host_statistics64 returned mach error %d", int(status))
	}
	return parseDarwinAvailableMemory(uint64(free), uint64(inactive), uint64(speculative), uint64(purgeable), pageSize)
}

func parseDarwinAvailableMemory(free, inactive, speculative, purgeable, pageSize uint64) (uint64, error) {
	if pageSize == 0 {
		return 0, fmt.Errorf("page size is zero")
	}
	pages := free
	for _, count := range []uint64{inactive, speculative, purgeable} {
		if math.MaxUint64-pages < count {
			return 0, fmt.Errorf("available page count overflows")
		}
		pages += count
	}
	if pages > math.MaxUint64/pageSize {
		return 0, fmt.Errorf("available memory byte count overflows")
	}
	return pages * pageSize, nil
}
