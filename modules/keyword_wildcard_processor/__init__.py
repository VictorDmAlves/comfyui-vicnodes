from .keyword_wildcard_processor import KeywordWildcardProcessor

NODE_CLASS_MAPPINGS = {
    "KeywordWildcardProcessor": KeywordWildcardProcessor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KeywordWildcardProcessor": "Keyword Wildcard Processor",
}


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
