"""Shared service graph and transport port assertions for installer journeys."""
from __future__ import annotations

import json
from urllib.parse import urlsplit


def service_ports(plan: dict) -> dict[str, int]:
    services = plan.get("serviceGraph", {}).get("services", [])
    return {item["id"]: item["port"] for item in services
            if isinstance(item, dict) and item.get("id") and isinstance(item.get("port"), int)
            and item["port"] > 0}


def service_transport_urls(plan: dict) -> dict[str, str]:
    services: dict[str, str] = {}
    for patch in plan.get("configPatches", []):
        if not isinstance(patch, dict):
            continue
        path = patch.get("path")
        if path == "/platform/adapterOptions":
            config = json.loads(patch.get("json", "{}"))
            configured = config.get("serviceTransport", {}).get("services", {})
            if isinstance(configured, dict):
                for service_id, settings in configured.items():
                    if isinstance(settings, dict) and isinstance(settings.get("url"), str):
                        services[service_id] = settings["url"]
            continue
        prefix = "/platform/adapterOptions/serviceTransport/services/"
        if isinstance(path, str) and path.startswith(prefix) and path.endswith("/url"):
            pointer_id = path[len(prefix):-len("/url")]
            service_id = pointer_id.replace("~1", "/").replace("~0", "~")
            value = json.loads(patch.get("json", "null"))
            if isinstance(value, str):
                services[service_id] = value
    return services


def service_transport_ports(plan: dict) -> dict[str, int]:
    urls = service_transport_urls(plan)
    if not urls:
        raise RuntimeError("resolved plan omitted service transport URLs")
    return {service_id: urlsplit(url).port for service_id, url in urls.items()
            if urlsplit(url).port is not None}


def external_transport_urls(plan: dict) -> dict[str, str]:
    return {service_id: url for service_id, url in service_transport_urls(plan).items()
            if service_id not in service_ports(plan)}


def _same_endpoint_with_port_offset(base_url: str, current_url: str, offset: int) -> bool:
    base, current = urlsplit(base_url), urlsplit(current_url)
    return (base.scheme == current.scheme and base.hostname == current.hostname
            and base.username == current.username and base.password == current.password
            and base.path == current.path and base.query == current.query and base.fragment == current.fragment
            and base.port is not None and current.port == base.port + offset)


def assert_managed_root_offset(plan_or_receipt: dict, base_ports: dict[str, int],
                               base_transport: dict[str, str], offset: int, label: str) -> None:
    """Assert the graph and its managed transport URLs use the same root offset."""
    ports = service_ports(plan_or_receipt)
    transport_ports = service_transport_ports(plan_or_receipt)
    if (not ports or set(ports) != set(base_ports)
            or any(port != base_ports[service_id] + offset for service_id, port in ports.items())):
        raise RuntimeError(f"{label} service ports do not share the {offset}-port root offset")
    base_urls = base_transport
    current_urls = service_transport_urls(plan_or_receipt)
    if not set(ports).issubset(transport_ports) or any(
            not _same_endpoint_with_port_offset(base_urls.get(service_id, ""),
                                                current_urls.get(service_id, ""), offset)
            for service_id in ports):
        raise RuntimeError(f"{label} managed service transport URLs do not share the {offset}-port root offset")


def assert_root_offset(plan_or_receipt: dict, base_ports: dict[str, int],
                       base_transport: dict[str, str], offset: int, label: str) -> None:
    """Assert managed service URLs shift with the root and external URLs stay fixed."""
    assert_managed_root_offset(plan_or_receipt, base_ports, base_transport, offset, label)
    expected_external = {service_id: url for service_id, url in base_transport.items()
                         if service_id not in base_ports}
    if external_transport_urls(plan_or_receipt) != expected_external:
        raise RuntimeError(f"{label} external service transport URLs changed from their configured addresses")


def assert_service_ports_preserved(before_plan: dict, after_plan: dict, label: str) -> None:
    """Assert lifecycle operations preserve a root's service and transport ports."""
    before_services, after_services = service_ports(before_plan), service_ports(after_plan)
    if before_services != after_services:
        raise RuntimeError(f"{label} changed service graph ports: before={before_services}, after={after_services}")
    before_transport = service_transport_ports(before_plan)
    after_transport = service_transport_ports(after_plan)
    if before_transport != after_transport:
        raise RuntimeError(f"{label} changed service transport ports: before={before_transport}, after={after_transport}")
